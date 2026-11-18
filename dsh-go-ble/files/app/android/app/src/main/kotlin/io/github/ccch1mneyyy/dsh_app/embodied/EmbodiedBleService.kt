package io.github.ccch1mneyyy.dsh_app.embodied

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import io.github.ccch1mneyyy.dsh_app.MainActivity
import io.github.ccch1mneyyy.dsh_app.R
import io.github.ccch1mneyyy.dsh_app.i18n.AppStrings

/**
 * Foreground service that keeps the BLE gateway alive while the local engine runs (protocol
 * §10.2): the phone is a BLE central for 鲸鲸, so the radio work must outlive the Flutter activity.
 * Modeled on [io.github.ccch1mneyyy.dsh_app.pet.PetOverlayService].
 *
 * Who starts it: RuntimeController via [syncEngine] — running engine + 设置页开关 on. Who stops it:
 * engine left running, the switch turned off, or the notification's 停止 action (which also turns
 * the switch off).
 *
 * The notification is the only UI while the app is backgrounded; its status line comes from the
 * gateway and is only rewritten when the line changes.
 */
class EmbodiedBleService : Service() {

    private var lastText = ""
    private val listener = EmbodiedGateway.Listener { event ->
        if (event["type"] == "status") updateNotification()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel(this)
        EmbodiedGateway.get(this).addListener(listener)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                EmbodiedPrefs.get(this).enabled = false
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_RECONNECT -> {
                EmbodiedGateway.get(this).reconnect()
                updateNotification()
                return START_NOT_STICKY
            }
        }
        state = STATE_STARTING
        val foreground = try {
            val notification = buildNotification(statusText(EmbodiedGateway.get(this).snapshot()))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            true
        } catch (e: Exception) {
            Log.w(TAG, "embodied service could not go foreground", e)
            false
        }
        if (!foreground) {
            running = false
            state = STATE_STOPPED
            EmbodiedGateway.get(this).fail("前台服务启动被系统拒绝")
            stopSelf()
            return START_NOT_STICKY
        }
        running = true
        state = STATE_RUNNING
        EmbodiedGateway.get(this).start()
        updateNotification()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        EmbodiedGateway.get(this).removeListener(listener)
        EmbodiedGateway.get(this).stop()
        running = false
        state = STATE_STOPPED
        super.onDestroy()
    }

    private fun updateNotification() {
        if (!running) return
        val text = statusText(EmbodiedGateway.get(this).snapshot())
        if (text == lastText) return
        lastText = text
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        runCatching { manager.notify(NOTIFICATION_ID, buildNotification(text)) }
    }

    private fun statusText(snapshot: Map<String, Any?>): String {
        val zh = !AppStrings.isEnglish(this)
        val ble = snapshot["ble"] as? Map<*, *>
        val bridge = snapshot["bridge"] as? Map<*, *>
        val bleState = ble?.get("state") as? String ?: EmbodiedGateway.STATE_IDLE
        val device = ble?.get("device") as? Map<*, *>
        val name = (device?.get("name") as? String)?.takeIf { it.isNotEmpty() }
            ?: (device?.get("address") as? String)
            ?: (if (zh) "设备" else "device")
        val bridgeConnected = bridge?.get("connected") == true
        val error = snapshot["lastError"] as? String ?: ""
        return when {
            bleState == EmbodiedGateway.STATE_READY && bridgeConnected ->
                if (zh) "已连接 $name" else "Connected to $name"
            bleState == EmbodiedGateway.STATE_READY ->
                if (zh) "蓝牙已连接，等待桥" else "Bluetooth connected, waiting for the bridge"
            bleState == EmbodiedGateway.STATE_CONNECTING ->
                if (zh) "正在连接…" else "Connecting…"
            bleState == EmbodiedGateway.STATE_SCANNING ->
                if (zh) "正在扫描…" else "Scanning…"
            error.isNotEmpty() -> error
            else -> if (zh) "等待设备" else "Waiting for the device"
        }
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, NOTIFICATION_ID,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val reconnect = PendingIntent.getService(
            this, NOTIFICATION_ID + 1,
            Intent(this, EmbodiedBleService::class.java).setAction(ACTION_RECONNECT),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this, NOTIFICATION_ID + 2,
            Intent(this, EmbodiedBleService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val zh = !AppStrings.isEnglish(this)
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_dsh)
            .setContentTitle(TITLE)
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, if (zh) "重连" else "Reconnect", reconnect).build())
            .addAction(Notification.Action.Builder(null, if (zh) "停止" else "Stop", stop).build())
            .build()
    }

    companion object {
        private const val TAG = "DshEmbodied"
        private const val CHANNEL_ID = "dsh-embodied-bluetooth"
        private const val NOTIFICATION_ID = 3092
        private const val TITLE = "鲸鲸蓝牙"
        private const val ACTION_STOP = "io.github.ccch1mneyyy.dsh_app.EMBODIED_STOP"
        private const val ACTION_RECONNECT = "io.github.ccch1mneyyy.dsh_app.EMBODIED_RECONNECT"

        const val STATE_STOPPED = "stopped"
        const val STATE_STARTING = "starting"
        const val STATE_RUNNING = "running"
        const val STATE_STOPPING = "stopping"

        /** What `status.service` reports; written only by this service. */
        @Volatile var state: String = STATE_STOPPED

        @Volatile private var running = false

        /** Starts or stops the service to match [on]; false when the system refused the start. */
        fun ensure(context: Context, on: Boolean): Boolean {
            if (on == running) return true
            return try {
                if (on) {
                    context.startForegroundService(Intent(context, EmbodiedBleService::class.java))
                } else {
                    context.stopService(Intent(context, EmbodiedBleService::class.java))
                }
                true
            } catch (e: Exception) {
                Log.w(TAG, "embodied service ${if (on) "start" else "stop"} refused", e)
                if (on) EmbodiedGateway.get(context).fail("前台服务启动被系统拒绝")
                false
            }
        }

        /**
         * Keeps the gateway in step with the engine: `status.engine` in the snapshot, and the
         * service up exactly while the engine runs and the 设置页 switch is on (protocol §10.2).
         * A transitional phase only updates the reported engine state; a crash restart keeps the
         * BLE link, and only a terminal phase stops the service.
         */
        fun syncEngine(context: Context, engineState: String, engineRunning: Boolean) {
            val gateway = EmbodiedGateway.get(context)
            gateway.setEngine(engineState)
            if (engineRunning) {
                if (EmbodiedPrefs.get(context).enabled) ensure(context, true)
            } else if (engineState == "stopped") {
                ensure(context, false)
            }
        }

        private fun ensureChannel(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            val zh = !AppStrings.isEnglish(context)
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    if (zh) "鲸鲸蓝牙" else "Jingjing Bluetooth",
                    NotificationManager.IMPORTANCE_MIN,
                ).apply { setShowBadge(false) },
            )
        }
    }
}
