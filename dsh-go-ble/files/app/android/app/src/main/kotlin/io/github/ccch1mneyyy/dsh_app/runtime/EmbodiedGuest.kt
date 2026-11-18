package io.github.ccch1mneyyy.dsh_app.runtime

import android.content.Context
import io.github.ccch1mneyyy.dsh_app.embodied.EmbodiedPrefs
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption

/**
 * 鲸鲸蓝牙: the DSH bridge plugin for the phone-side BLE gateway (protocol §10.1). The bridge
 * (`app/assets/engine/embodied/`, synced from `bridge/` by `tooling/sync-embodied-assets.mjs`) is
 * copied into the rootfs straight from the Flutter asset bundle at every engine start, together
 * with the overlay that inserts it by absolute path and the loopback token the App gateway will
 * present as `?token=` (§8.2).
 *
 * Written at every engine start like message search (no rootfs rebuild). The overlay is passed with
 * --patch on normal launches only, never in safe mode, and only when everything was written; a
 * plugin that fails to load leaves DSH running, and the settings page then simply reports that the
 * bridge is not reachable.
 */
object EmbodiedGuest {
    const val GUEST_DIR = "/opt/dsh-app/embodied"
    const val PATCH = "$GUEST_DIR/embodied.patch.yml"
    const val ENTRY = "$GUEST_DIR/lib/index.js"

    /** Where Flutter packs `app/assets/engine/embodied/` inside the APK's assets. */
    private const val ASSET_DIR = "flutter_assets/assets/engine/embodied"

    private const val WEB_PATCH_ARG = "--patch /etc/dsh-app/dsh-web.patch.yml"
    private const val DSH_WEB = "/usr/local/bin/dsh web"

    /** The overlay (protocol §10.1); the token is generated once by [EmbodiedPrefs.tokenOrCreate]. */
    fun patchYaml(token: String): String = """# dsh-app: 鲸鲸蓝牙 bridge (BLE gateway). The DSH App rewrites this directory at every engine
# start and passes this file with --patch on normal launches (never in safe mode). Edits do not
# survive.
- insert:
    - id: dsh-embodied-bridge
      name: $ENTRY
      config:
        host: 127.0.0.1
        port: 7788
        wsToken: "$token"
        discover: false
        imageKeep: 5
        voiceKeep: 20
"""

    /** The launch shell command with the overlay right after the app's own one; null when [arg] is not the `dsh web` launch. */
    fun launchArg(arg: String): String? {
        val web = arg.indexOf("$DSH_WEB ")
        if (web < 0 || arg.indexOf("$DSH_WEB ", web + 1) >= 0 || arg.contains("--profile")) return null
        val patch = arg.indexOf(WEB_PATCH_ARG, web)
        val at = if (patch >= 0 && arg.indexOf(WEB_PATCH_ARG, patch + 1) < 0) patch + WEB_PATCH_ARG.length else web + DSH_WEB.length
        return arg.substring(0, at) + " --patch $PATCH" + arg.substring(at)
    }

    fun file(rootfs: File) = File(rootfs, PATCH.removePrefix("/"))

    /**
     * Copies the bridge modules recursively, then writes the overlay with the current token; files
     * already up to date are left alone. False when anything could not be written, so this launch
     * leaves the bridge out; cleanup is best effort.
     */
    fun writeFiles(context: Context, rootfs: File): Boolean {
        val patch = file(rootfs)
        return try {
            val dir = File(rootfs, GUEST_DIR.removePrefix("/"))
            if (Files.isSymbolicLink(dir.toPath()) || (dir.exists() && !dir.isDirectory)) dir.delete()
            if (!dir.isDirectory && !dir.mkdirs()) throw IOException("could not create ${dir.path}")
            copyAssetDir(context, ASSET_DIR, dir)
            val token = EmbodiedPrefs.get(context).tokenOrCreate()
            writeIfChanged(patch, patchYaml(token).toByteArray())
            true
        } catch (_: Exception) {
            patch.delete()
            false
        }
    }

    /** `assets.list` on a file path returns no children, so the recursion finds leaves by itself. */
    private fun copyAssetDir(context: Context, assetPath: String, target: File) {
        val children = context.assets.list(assetPath) ?: throw IOException("missing asset $assetPath")
        if (children.isEmpty()) {
            writeIfChanged(target, context.assets.open(assetPath).use { it.readBytes() })
            return
        }
        if (!target.isDirectory && !target.mkdirs()) throw IOException("could not create ${target.path}")
        for (name in children) copyAssetDir(context, "$assetPath/$name", File(target, name))
    }

    /** Sibling temp file renamed over [target]; only a regular file is compared (never a link or FIFO). */
    private fun writeIfChanged(target: File, bytes: ByteArray) {
        if (Files.isRegularFile(target.toPath(), LinkOption.NOFOLLOW_LINKS) && target.readBytes().contentEquals(bytes)) return
        val tmp = File(target.parentFile, ".${target.name}.dsh-app-${System.nanoTime()}.tmp")
        try {
            tmp.writeBytes(bytes)
            tmp.setReadable(true, false)
            if (!tmp.renameTo(target)) throw IOException("could not replace ${target.path}")
        } finally {
            if (tmp.exists()) tmp.delete()
        }
    }
}
