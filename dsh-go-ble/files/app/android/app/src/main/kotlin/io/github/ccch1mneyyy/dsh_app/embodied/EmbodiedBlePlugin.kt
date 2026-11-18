package io.github.ccch1mneyyy.dsh_app.embodied

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry

/**
 * Flutter bridge for 鲸鲸蓝牙 (protocol §10.3): MethodChannel `dsh/embodied_ble` and EventChannel
 * `dsh/embodied_ble/events`.
 *
 * The plugin is a thin shell: [EmbodiedGateway] owns the links, [EmbodiedBleService] keeps them
 * alive, and [EmbodiedPrefs] holds the settings. Its own job is the permission round-trip
 * (ACCESS_FINE_LOCATION is required for BLE scanning under the App's targetSdk 28 legacy model),
 * which follows the pattern of `voice/VoicePlugin`.
 *
 * Switch-on path: `configure {enabled:true}` (or `start`) persists the switch and starts the
 * foreground service, asking for the location permission through the activity when it is missing.
 */
class EmbodiedBlePlugin :
    FlutterPlugin,
    ActivityAware,
    MethodChannel.MethodCallHandler,
    EventChannel.StreamHandler,
    PluginRegistry.RequestPermissionsResultListener {

    private lateinit var appContext: Context
    private lateinit var methods: MethodChannel
    private lateinit var eventChannel: EventChannel
    private var activity: ActivityPluginBinding? = null
    private var sink: EventChannel.EventSink? = null
    private var pendingPermission: ((Boolean) -> Unit)? = null

    /** Gateway events are already delivered on the main thread, where EventSink must be called. */
    private val gatewayListener = EmbodiedGateway.Listener { event -> sink?.success(event) }

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        appContext = binding.applicationContext
        methods = MethodChannel(binding.binaryMessenger, "dsh/embodied_ble").also { it.setMethodCallHandler(this) }
        eventChannel = EventChannel(binding.binaryMessenger, "dsh/embodied_ble/events").also { it.setStreamHandler(this) }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methods.setMethodCallHandler(null)
        eventChannel.setStreamHandler(null)
        EmbodiedGateway.get(appContext).removeListener(gatewayListener)
        sink = null
    }

    // ActivityAware

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding
        binding.addRequestPermissionsResultListener(this)
    }

    override fun onDetachedFromActivityForConfigChanges() = onDetachedFromActivity()

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)

    override fun onDetachedFromActivity() {
        activity?.removeRequestPermissionsResultListener(this)
        activity = null
        // The page that would have shown the result is gone; answer it rather than hold it.
        pendingPermission?.invoke(false)
        pendingPermission = null
    }

    // MethodChannel

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val gateway = EmbodiedGateway.get(appContext)
        when (call.method) {
            "status" -> result.success(mapOf("status" to gateway.snapshot()))

            "start" -> enable(shape = "start", result = result)

            "stop" -> {
                EmbodiedPrefs.get(appContext).enabled = false
                EmbodiedBleService.ensure(appContext, false)
                result.success(mapOf("ok" to true, "status" to gateway.snapshot()))
            }

            "scan" -> {
                val timeout = call.argument<Number>("timeoutMs")?.toLong() ?: DEFAULT_SCAN_MS
                gateway.scan(timeout) { ok, devices ->
                    result.success(mapOf("ok" to ok, "devices" to devices))
                }
            }

            "connect" -> result.success(mapOf("ok" to gateway.connect(call.argument<String>("address").orEmpty())))

            "disconnect" -> result.success(mapOf("ok" to gateway.disconnect()))

            "config" -> result.success(mapOf("config" to EmbodiedPrefs.get(appContext).config()))

            "configure" -> configure(call, result)

            "openSystemBluetooth" -> {
                val host = activity?.activity
                val intent = Intent(Settings.ACTION_BLUETOOTH_SETTINGS)
                val opened = runCatching {
                    if (host != null) host.startActivity(intent)
                    else appContext.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }.isSuccess
                result.success(mapOf("ok" to opened))
            }

            else -> result.notImplemented()
        }
    }

    /** Switch on: persist `enabled`, obtain the scan permission when missing, start the service. */
    private fun enable(shape: String, result: MethodChannel.Result) {
        val gateway = EmbodiedGateway.get(appContext)
        when (gateway.adapterState()) {
            "missing" -> return finishEnable(shape, false, "这台手机没有蓝牙", result)
            "off" -> return finishEnable(shape, false, "蓝牙未开启，请在系统设置中打开蓝牙", result)
        }
        if (hasLocationPermission()) {
            val started = startService()
            return finishEnable(shape, started, if (started) "" else "前台服务启动被系统拒绝", result)
        }
        requestLocation { granted ->
            if (granted) {
                val started = startService()
                finishEnable(shape, started, if (started) "" else "前台服务启动被系统拒绝", result)
            } else {
                gateway.notePermissionDenied()
                finishEnable(shape, false, "需要定位权限才能扫描蓝牙设备", result, needPermission = true)
            }
        }
    }

    /** Persists the switch and starts the service; a refused start leaves the switch off. */
    private fun startService(): Boolean {
        val started = EmbodiedBleService.ensure(appContext, true)
        EmbodiedPrefs.get(appContext).enabled = started
        return started
    }

    private fun finishEnable(
        shape: String,
        ok: Boolean,
        error: String,
        result: MethodChannel.Result,
        needPermission: Boolean = false,
    ) {
        val gateway = EmbodiedGateway.get(appContext)
        if (error.isNotEmpty()) gateway.fail(error)
        val base = when (shape) {
            "start" -> mutableMapOf<String, Any?>("ok" to ok, "status" to gateway.snapshot())
            else -> mutableMapOf<String, Any?>("ok" to ok, "config" to EmbodiedPrefs.get(appContext).config())
        }
        if (needPermission) base["needPermission"] = listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        result.success(base)
    }

    private fun configure(call: MethodCall, result: MethodChannel.Result) {
        val prefs = EmbodiedPrefs.get(appContext)
        val gateway = EmbodiedGateway.get(appContext)
        call.argument<String>("bridgeUrl")?.let { prefs.bridgeUrl = it }
        call.argument<Boolean>("autoConnect")?.let { prefs.autoConnect = it }
        call.argument<String>("devicePrefix")?.let { prefs.devicePrefix = it }
        val enabled = call.argument<Boolean>("enabled")
        if (enabled == true) {
            // Turning the switch on goes through the same permission/service path as `start`.
            enable(shape = "configure", result = result)
            return
        }
        if (enabled == false) {
            prefs.enabled = false
            EmbodiedBleService.ensure(appContext, false)
            result.success(mapOf("ok" to true, "config" to prefs.config()))
            return
        }
        // Address / prefix only: a running service re-reads them on the next connection attempt.
        if (EmbodiedBleService.state == EmbodiedBleService.STATE_RUNNING) gateway.applyConfig()
        result.success(mapOf("ok" to true, "config" to prefs.config()))
    }

    // Permission

    private fun hasLocationPermission(): Boolean =
        appContext.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun requestLocation(onDone: (Boolean) -> Unit) {
        val host = activity?.activity
        if (host == null || pendingPermission != null) return onDone(false)
        pendingPermission = onDone
        host.requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION), REQUEST_CODE)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ): Boolean {
        if (requestCode != REQUEST_CODE) return false
        val callback = pendingPermission ?: return true
        pendingPermission = null
        callback(grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED)
        return true
    }

    // EventChannel

    override fun onListen(arguments: Any?, eventSink: EventChannel.EventSink) {
        sink = eventSink
        val gateway = EmbodiedGateway.get(appContext)
        gateway.addListener(gatewayListener)
        eventSink.success(mapOf("type" to "status", "status" to gateway.snapshot()))
    }

    override fun onCancel(arguments: Any?) {
        EmbodiedGateway.get(appContext).removeListener(gatewayListener)
        sink = null
    }

    private companion object {
        const val REQUEST_CODE = 0x4542
        const val DEFAULT_SCAN_MS = 10_000L
    }
}
