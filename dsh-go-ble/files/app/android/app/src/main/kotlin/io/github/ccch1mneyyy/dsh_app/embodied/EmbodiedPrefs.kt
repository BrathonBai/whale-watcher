package io.github.ccch1mneyyy.dsh_app.embodied

import android.content.Context
import android.content.SharedPreferences
import java.security.SecureRandom

/**
 * 设置 › 鲸鲸蓝牙: the BLE gateway's settings in the app-private `embodied_ble` preferences.
 *
 * The bridge token is not a user setting. The guest plugin (runtime/EmbodiedGuest.kt) writes the
 * same value into the injected bridge config at every engine start, and the gateway appends it to
 * the loopback WebSocket URL (`?token=`, protocol §8.2); the Flutter side never sees it.
 */
class EmbodiedPrefs private constructor(private val prefs: SharedPreferences) {

    /** Where the injected bridge listens; loopback because PRoot shares the app's network namespace. */
    var bridgeUrl: String
        get() = prefs.getString(KEY_BRIDGE_URL, DEFAULT_BRIDGE_URL).orEmpty().trim().ifEmpty { DEFAULT_BRIDGE_URL }
        set(value) = prefs.edit().putString(KEY_BRIDGE_URL, value.trim()).apply()

    /** 32 lowercase hex; empty until the guest has prepared the bridge once. */
    var token: String
        get() = prefs.getString(KEY_TOKEN, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    /** Connect to the remembered device on start, and keep retrying after a drop. */
    var autoConnect: Boolean
        get() = prefs.getBoolean(KEY_AUTO_CONNECT, true)
        set(value) = prefs.edit().putBoolean(KEY_AUTO_CONNECT, value).apply()

    /** Advertised-name prefix used to pick a device; empty accepts any device on our service. */
    var devicePrefix: String
        get() = prefs.getString(KEY_DEVICE_PREFIX, DEFAULT_DEVICE_PREFIX).orEmpty().trim()
        set(value) = prefs.edit().putString(KEY_DEVICE_PREFIX, value.trim()).apply()

    /** Last address that reached the ready state, for [autoConnect]. */
    var lastAddress: String
        get() = prefs.getString(KEY_LAST_ADDRESS, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_LAST_ADDRESS, value).apply()

    /** The 设置页 switch; the foreground service runs only while this is true and the engine runs. */
    var enabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_ENABLED, value).apply()

    /**
     * The bridge token, generated once with [SecureRandom] (16 bytes → 32 hex). Both the guest and
     * the gateway go through here, so the injected bridge config and the URL always agree.
     */
    @Synchronized
    fun tokenOrCreate(): String {
        val current = token
        if (TOKEN_HEX.matches(current)) return current
        val bytes = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val created = buildString(32) {
            for (byte in bytes) {
                append(HEX[(byte.toInt() shr 4) and 0x0F])
                append(HEX[byte.toInt() and 0x0F])
            }
        }
        token = created
        return created
    }

    /** What the settings page reads; the token stays native. */
    fun config(): Map<String, Any?> = mapOf(
        "bridgeUrl" to bridgeUrl,
        "autoConnect" to autoConnect,
        "devicePrefix" to devicePrefix,
        "lastAddress" to lastAddress,
        "enabled" to enabled,
    )

    companion object {
        const val FILE = "embodied_ble"
        const val DEFAULT_BRIDGE_URL = "ws://127.0.0.1:7788/device"
        const val DEFAULT_DEVICE_PREFIX = "Jingjing-"

        private const val KEY_BRIDGE_URL = "bridgeUrl"
        private const val KEY_TOKEN = "token"
        private const val KEY_AUTO_CONNECT = "autoConnect"
        private const val KEY_DEVICE_PREFIX = "devicePrefix"
        private const val KEY_LAST_ADDRESS = "lastAddress"
        private const val KEY_ENABLED = "enabled"
        private const val HEX = "0123456789abcdef"
        private val TOKEN_HEX = Regex("[0-9a-f]{32}")

        @Volatile private var instance: EmbodiedPrefs? = null

        fun get(context: Context): EmbodiedPrefs =
            instance ?: synchronized(this) {
                instance ?: EmbodiedPrefs(
                    context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE),
                ).also { instance = it }
            }
    }
}
