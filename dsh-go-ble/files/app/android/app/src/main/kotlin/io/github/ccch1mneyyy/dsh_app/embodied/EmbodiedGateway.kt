package io.github.ccch1mneyyy.dsh_app.embodied

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Log
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The transparent BLE↔WebSocket gateway (protocol §4, §10.2): scans for the device, brings up the
 * GATT link (MTU 247 → services → notifications), connects the loopback bridge socket, then only
 * moves bytes. Nothing here interprets the bridge's JSON; the payload is framed and passed on.
 *
 * All GATT work runs on one executor thread, because Android's GATT stack rejects concurrent
 * operations. Public methods are callable from any thread; they hand work to that executor and
 * report state through [Listener] events (always delivered on the main thread).
 *
 * Lifecycle: [EmbodiedBleService] owns start/stop; the engine's phase drives the service
 * (RuntimeController → syncEngine). Link counters are per run and reset by [start].
 */
class EmbodiedGateway private constructor(private val context: Context) {

    fun interface Listener {
        fun onEvent(event: Map<String, Any?>)
    }

    private val prefs = EmbodiedPrefs.get(context)
    private val main = Handler(Looper.getMainLooper())
    private val worker: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "embodied-gatt").apply { isDaemon = true }
    }
    private val listeners = CopyOnWriteArrayList<Listener>()
    private val adapter: BluetoothAdapter? =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
    private val reassembler = EmbodiedReassembler()
    private val txQueue = ArrayDeque<ByteArray>()
    // The device sends hello right after it sees the CCCD; the bridge socket may still be
    // connecting at that moment. Keep the first small text messages and flush them on open.
    private val earlyBridge = ArrayDeque<String>()
    private var earlyBridgeBytes = 0

    private var queuedBytes = 0
    private var scanner: BluetoothLeScanner? = null
    private var scanning = false
    private var scanResults = LinkedHashMap<String, ScanHit>()
    private var scanDone: ((Boolean, List<Map<String, Any?>>) -> Unit)? = null
    private var autoScan = false
    private var scanTimer: Runnable? = null
    private var gatt: BluetoothGatt? = null
    private var down: BluetoothGattCharacteristic? = null
    private var ws: EmbodiedWebSocket? = null
    private var currentWsUrl = ""
    private var wsOpenedOnce = false
    private var wsAttempt = 0
    private var reconnectAttempt = 0
    private var manualDisconnect = false
    private var reconnectTimer: Runnable? = null
    private var bridgeTimer: Runnable? = null
    private var txWakeupScheduled = false
    private val txWakeup = Runnable {
        txWakeupScheduled = false
        worker.execute { pumpTx() }
    }
    private var lastDropLogAt = 0L
    private var negotiatedMtu = 0
    // Some Android stacks never deliver onMtuChanged even though the exchange happened;
    // keep a retry budget and read BluetoothGatt.getMtu() eagerly when it is missing.
    private var mtuRetry = 0
    private var notificationsEnabled = false

    @Volatile private var running = false
    @Volatile private var link = BleLink()
    @Volatile private var stats = Stats()
    @Volatile private var bridgeConnected = false
    @Volatile private var lastError = ""
    @Volatile private var engine = "unknown"
    @Volatile private var permissionDenied = false

    fun addListener(listener: Listener) {
        listeners += listener
    }

    fun removeListener(listener: Listener) {
        listeners -= listener
    }

    /** The engine phase as RuntimeController sees it; feeds `status.engine` for the settings page. */
    fun setEngine(state: String) {
        if (engine == state) return
        engine = state
        emitStatus()
    }

    fun adapterState(): String {
        val bluetooth = adapter ?: return "missing"
        return try {
            if (bluetooth.isEnabled) "on" else "off"
        } catch (_: SecurityException) {
            "missing"
        }
    }

    fun permissionState(): String = when {
        hasLocationPermission() -> "granted"
        permissionDenied -> "denied"
        else -> "missing"
    }

    /** The settings page asked and the person said no (or "don't ask again"). */
    fun notePermissionDenied() {
        permissionDenied = true
    }

    /** A readable failure for the page; also shown as `status.lastError`. */
    fun fail(message: String) {
        lastError = message
        worker.execute { emitStatus() }
    }

    /** The status snapshot of protocol §10.3. */
    fun snapshot(): Map<String, Any?> {
        val current = link
        val counters = stats
        return mapOf(
            "service" to EmbodiedBleService.state,
            "enabled" to prefs.enabled,
            "adapter" to adapterState(),
            "permission" to permissionState(),
            "engine" to engine,
            "ble" to mapOf(
                "state" to current.state,
                "device" to current.address?.let {
                    mapOf("name" to current.name, "address" to it, "rssi" to current.rssi, "mtu" to current.mtu)
                },
                "txBytes" to counters.txBytes,
                "rxBytes" to counters.rxBytes,
                "txDrop" to counters.txDrop,
                "rxDrop" to counters.rxDrop,
            ),
            "bridge" to mapOf(
                "url" to prefs.bridgeUrl,
                "connected" to bridgeConnected,
                "reconnects" to counters.reconnects,
            ),
            "lastError" to lastError,
        )
    }

    fun start() {
        if (running) return
        // Set before the worker task so a scan/connect call right after start() does not see a
        // stale stopped gateway; everything else is initialized on the executor.
        running = true
        worker.execute {
            permissionDenied = false
            manualDisconnect = false
            reconnectAttempt = 0
            wsAttempt = 0
            wsOpenedOnce = false
            queuedBytes = 0
            txQueue.clear()
            txWakeupScheduled = false
            reassembler.reset()
            stats = Stats()
            link = BleLink()
            bridgeConnected = false
            lastError = ""
            emitStatus()
            when (adapterState()) {
                "missing" -> failHere("这台手机没有蓝牙")
                "off" -> failHere("蓝牙未开启")
                else -> if (prefs.autoConnect) beginConnect()
            }
        }
    }

    fun stop() {
        running = false
        worker.execute {
            cancelTimers()
            autoScan = false
            finishScan(report = true)
            closeWebSocket()
            closeGatt()
            txQueue.clear()
            queuedBytes = 0
            reassembler.reset()
            link = BleLink()
            lastError = ""
            emitStatus()
        }
    }

    /**
     * A settings-page scan. [done] receives the hits on the main thread; a scan started by the
     * auto-connect flow reports through the link state instead.
     *
     * Works while the service is stopped too (the page may let someone look for devices before
     * turning the switch on); connecting still needs the service, because the bridge socket and the
     * foreground keep-alive come with it.
     */
    fun scan(timeoutMs: Long, done: (Boolean, List<Map<String, Any?>>) -> Unit) {
        when (adapterState()) {
            "missing" -> {
                fail("这台手机没有蓝牙")
                main.post { done(false, emptyList()) }
                return
            }
            "off" -> {
                fail("蓝牙未开启")
                main.post { done(false, emptyList()) }
                return
            }
        }
        val timeout = timeoutMs.coerceIn(MIN_SCAN_MS, MAX_SCAN_MS)
        worker.execute {
            if (running) return@execute startScan(timeout, auto = false, done = done)
            // Service stopped: a plain scan that only reports, so the page can list devices.
            startDetachedScan(timeout, done)
        }
    }

    /** Starts connecting to [address]; progress and failures arrive as status events. */
    fun connect(address: String): Boolean {
        val normalized = address.trim().uppercase()
        if (normalized.isEmpty()) {
            fail("设备地址为空")
            return false
        }
        when (adapterState()) {
            "missing" -> {
                fail("这台手机没有蓝牙")
                return false
            }
            "off" -> {
                fail("蓝牙未开启")
                return false
            }
        }
        if (!running) {
            fail("鲸鲸蓝牙未启动")
            return false
        }
        worker.execute {
            if (!running) return@execute
            finishScan(report = true)
            manualDisconnect = false
            reconnectAttempt = 0
            connectInternal(normalized, rssi = 0)
        }
        return true
    }

    fun disconnect(): Boolean {
        worker.execute {
            manualDisconnect = true
            cancelTimers()
            finishScan(report = true)
            closeWebSocket()
            closeGatt()
            txQueue.clear()
            queuedBytes = 0
            reassembler.reset()
            link = BleLink()
            lastError = ""
            emitStatus()
        }
        return true
    }

    /** The notification's 重连 action: tear both links down and try the same device again. */
    fun reconnect(): Boolean {
        if (!running) {
            fail("鲸鲸蓝牙未启动")
            return false
        }
        worker.execute {
            if (!running) return@execute
            manualDisconnect = false
            reconnectAttempt = 0
            wsAttempt = 0
            cancelTimers()
            finishScan(report = true)
            closeWebSocket()
            closeGatt()
            txQueue.clear()
            queuedBytes = 0
            reassembler.reset()
            link = BleLink()
            lastError = ""
            emitStatus()
            when (adapterState()) {
                "missing" -> failHere("这台手机没有蓝牙")
                "off" -> failHere("蓝牙未开启")
                else -> beginConnect()
            }
        }
        return true
    }

    /** Bridge URL, token or auto-connect changed under a running service. */
    fun applyConfig() {
        worker.execute {
            if (!running) {
                emitStatus()
                return@execute
            }
            if (adapterState() != "on") {
                failHere("蓝牙未开启")
                return@execute
            }
            if (link.state == STATE_READY && effectiveUrl() != currentWsUrl) {
                closeWebSocket()
                openWebSocket()
            }
            if (prefs.autoConnect && link.state == STATE_IDLE && gatt == null) {
                manualDisconnect = false
                beginConnect()
            }
            emitStatus()
        }
    }

    // Connection pipeline

    private fun beginConnect() {
        if (!running || manualDisconnect) return
        val address = prefs.lastAddress
        if (address.isNotEmpty()) {
            connectInternal(address, rssi = 0)
            return
        }
        // Scanning a BLE device needs the location permission under the legacy (targetSdk 28)
        // Bluetooth model; retrying without it would only repeat the same failure.
        if (!hasLocationPermission()) return failHere("缺少定位权限")
        startScan(DEFAULT_SCAN_MS, auto = true, done = null)
    }

    private fun connectInternal(address: String, rssi: Int) {
        if (!running) return
        if (adapterState() != "on") {
            failHere("蓝牙未开启")
            return
        }
        closeWebSocket()
        closeGatt()
        val bluetooth = adapter ?: return failHere("这台手机没有蓝牙")
        val device = try {
            bluetooth.getRemoteDevice(address)
        } catch (_: IllegalArgumentException) {
            lastError = "设备地址无效: $address"
            emitStatus()
            scheduleReconnect(lastError)
            return
        }
        link = BleLink(state = STATE_CONNECTING, address = address, rssi = rssi)
        lastError = ""
        emitStatus()
        gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        if (gatt == null) {
            link = BleLink()
            lastError = "无法建立 GATT 连接"
            emitStatus()
            scheduleReconnect(lastError)
        }
    }

    private fun onGattConnected(g: BluetoothGatt) {
        link = link.copy(state = STATE_CONNECTING, mtu = 0)
        lastError = ""
        mtuRetry = 0
        notificationsEnabled = false
        emitStatus()
        // §3: ask for a short interval and 2M PHY; a refusal is not an error.
        runCatching { g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH) }
        runCatching {
            g.setPreferredPhy(
                BluetoothDevice.PHY_LE_2M_MASK,
                BluetoothDevice.PHY_LE_2M_MASK,
                BluetoothDevice.PHY_LE_2M_MASK,
            )
        }
        // Keep the exact order the Android stack expects: MTU exchange first, discovery in
        // onMtuChanged. Starting discovery in the same callback made some stacks drop the MTU
        // request entirely (no onMtuChanged, getMtu() stayed 0).
        val mtuAsked = runCatching { g.requestMtu(REQUESTED_MTU) }.getOrDefault(false)
        Log.w(TAG, "connected, requestMtu=$mtuAsked")
        if (!mtuAsked) {
            if (!runCatching { g.discoverServices() }.getOrDefault(false)) onGattLost(g, "服务发现失败")
            return
        }
        main.postDelayed({
            worker.execute {
                if (g === gatt && g.services.isEmpty() && link.state == STATE_CONNECTING) {
                    Log.w(TAG, "no onMtuChanged after 1.5s; discovering services anyway")
                    if (!runCatching { g.discoverServices() }.getOrDefault(false)) onGattLost(g, "服务发现失败")
                }
            }
        }, 1500)
    }

    private fun handleMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
        if (status == BluetoothGatt.GATT_SUCCESS) negotiatedMtu = mtu
        Log.w(TAG, "mtu=$mtu status=$status negotiated=$negotiatedMtu")
        if (!runCatching { g.discoverServices() }.getOrDefault(false) && g.services.isEmpty()) {
            onGattLost(g, "服务发现失败")
        }
    }

    @Suppress("DEPRECATION")
    private fun onServicesDiscovered(g: BluetoothGatt) {
        val service = g.getService(SERVICE_UUID)
        if (service == null) {
            Log.w(TAG, "service missing; found=${g.services.map { it.uuid.toString() }}")
            return onGattLost(g, "未找到鲸鲸服务")
        }
        val downChar = service.getCharacteristic(DOWN_UUID)
        val upChar = service.getCharacteristic(UP_UUID)
        Log.w(TAG, "services discovered: down=${downChar != null} up=${upChar != null} " +
                "chars=${service.characteristics.map { it.uuid.toString().substring(4, 8) }}")
        if (downChar == null || upChar == null) return onGattLost(g, "未找到鲸鲸特征")
        if (!runCatching { g.setCharacteristicNotification(upChar, true) }.getOrDefault(false)) {
            return onGattLost(g, "无法开启通知")
        }
        val cccd = upChar.getDescriptor(CCCD_UUID)
        if (cccd == null) return onGattLost(g, "缺少 CCCD")
        down = downChar
        cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        val written = runCatching { g.writeDescriptor(cccd) }.getOrDefault(false)
        Log.w(TAG, "writeDescriptor=$written")
        if (written) notificationsEnabled = true
        if (!written) onGattLost(g, "无法开启通知")
    }

    private fun onGattReady(g: BluetoothGatt) {
        if (g !== gatt) return
        if (link.state == STATE_READY) return
        if (negotiatedMtu == 0) {
            // API 34+ has getMtu(); this SDK's stubs lack it, so read it reflectively.
            negotiatedMtu = runCatching {
                BluetoothGatt::class.java.getMethod("getMtu").invoke(g) as Int
            }.getOrDefault(0)
            Log.w(TAG, "mtu via getMtu()=$negotiatedMtu")
        }
        if (negotiatedMtu < MIN_MTU && mtuRetry < 2) {
            mtuRetry++
            Log.w(TAG, "mtu still $negotiatedMtu, retry #$mtuRetry")
            runCatching { g.requestMtu(REQUESTED_MTU) }
            main.postDelayed({ worker.execute { onGattReady(g) } }, 800)
            return
        }
        val mtu = negotiatedMtu
        if (mtu < MIN_MTU) {
            return onGattLost(g, "MTU 过小 ($mtu)，至少需要 $MIN_MTU")
        }
        mtuRetry = 0
        val address = g.device.address
        val name = runCatching { g.device.name }.getOrNull()?.takeIf { it.isNotEmpty() }
        val rssi = link.rssi
        prefs.lastAddress = address
        link = BleLink(STATE_READY, name, address, rssi, mtu)
        reconnectAttempt = 0
        lastError = ""
        emitStatus()
        runCatching { g.readRemoteRssi() }
        openWebSocket()
    }

    /** Drops the BLE link and, when the person did not ask for it, retries with backoff. */
    private fun onGattLost(g: BluetoothGatt, reason: String) {
        Log.w(TAG, "gatt lost: $reason")
        if (g === gatt) {
            closeGatt()
            closeWebSocket()
            txQueue.clear()
            queuedBytes = 0
            reassembler.reset()
            link = BleLink()
        }
        lastError = reason
        emitStatus()
        scheduleReconnect(reason)
    }

    private fun closeGatt() {
        val current = gatt
        gatt = null
        down = null
        negotiatedMtu = 0
        mtuRetry = 0
        notificationsEnabled = false
        if (current != null) {
            runCatching { current.disconnect() }
            runCatching { current.close() }
        }
    }

    private fun scheduleReconnect(reason: String) {
        if (!running || manualDisconnect || !prefs.autoConnect) return
        reconnectTimer?.let { main.removeCallbacks(it) }
        val delay = BACKOFF_MS[reconnectAttempt.coerceAtMost(BACKOFF_MS.size - 1)]
        reconnectAttempt++
        lastError = reason
        val task = Runnable {
            reconnectTimer = null
            worker.execute {
                if (running && !manualDisconnect && link.state == STATE_IDLE) beginConnect()
            }
        }
        reconnectTimer = task
        main.postDelayed(task, delay)
        emitStatus()
    }

    // Scanning

    private fun startScan(timeoutMs: Long, auto: Boolean, done: ((Boolean, List<Map<String, Any?>>) -> Unit)?) {
        cancelScanTimer()
        stopLeScan()
        scanResults = LinkedHashMap()
        scanDone = done
        autoScan = auto
        link = link.copy(state = STATE_SCANNING, name = null, address = null, rssi = 0, mtu = 0)
        emitStatus()
        val leScanner = adapter?.bluetoothLeScanner
        if (leScanner == null) return failScan("蓝牙扫描不可用")
        scanner = leScanner
        scanning = true
        val filters = listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build())
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        val started = runCatching { leScanner.startScan(filters, settings, scanCallback) }
        if (started.isFailure) {
            return failScan("扫描失败: ${started.exceptionOrNull()?.message ?: "缺少定位权限"}")
        }
        val task = Runnable {
            scanTimer = null
            worker.execute { finishScan(report = true) }
        }
        scanTimer = task
        main.postDelayed(task, timeoutMs)
    }

    /**
     * The service is stopped: scan only for the page's device list. No link state, no
     * auto-connect — the gateway's own pipeline needs the foreground service around it.
     */
    private fun startDetachedScan(timeoutMs: Long, done: (Boolean, List<Map<String, Any?>>) -> Unit) {
        // A scan failure and the timeout can both decide to report; the page takes one answer.
        val reported = AtomicBoolean(false)
        val report = { ok: Boolean, hits: List<ScanHit> ->
            if (reported.compareAndSet(false, true)) main.post { done(ok, hits.map { it.toWire() }) }
        }
        if (!hasLocationPermission()) {
            lastError = "缺少定位权限"
            emitStatus()
            report(false, emptyList())
            return
        }
        val leScanner = adapter?.bluetoothLeScanner
        if (leScanner == null) {
            lastError = "蓝牙扫描不可用"
            emitStatus()
            report(false, emptyList())
            return
        }
        val hits = LinkedHashMap<String, ScanHit>()
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                worker.execute {
                    val name = runCatching { result.scanRecord?.deviceName ?: result.device.name }.getOrNull().orEmpty()
                    hits[result.device.address] = ScanHit(name, result.device.address, result.rssi)
                }
            }

            override fun onScanFailed(errorCode: Int) {
                worker.execute {
                    lastError = "扫描失败 (code=$errorCode)"
                    emitStatus()
                    report(false, hits.values.toList())
                }
            }
        }
        val filters = listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build())
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        val started = runCatching { leScanner.startScan(filters, settings, callback) }
        if (started.isFailure) {
            lastError = "扫描失败: ${started.exceptionOrNull()?.message ?: "缺少定位权限"}"
            emitStatus()
            report(false, emptyList())
            return
        }
        main.postDelayed({
            worker.execute {
                runCatching { leScanner.stopScan(callback) }
                report(true, hits.values.toList())
            }
        }, timeoutMs)
    }

    /**
     * Ends the scan. A settings-page scan reports its hits; the auto-connect scan connects the
     * first name-prefix match, or retries on the backoff ladder when nothing matched.
     */
    private fun finishScan(report: Boolean) {
        val auto = autoScan
        val hits = stopLeScan()
        cancelScanTimer()
        autoScan = false
        val callback = scanDone
        scanDone = null
        if (link.state == STATE_SCANNING) link = link.copy(state = STATE_IDLE)
        if (!auto) {
            emitStatus()
            if (report && callback != null) {
                main.post { callback(true, hits.map { it.toWire() }) }
            }
            return
        }
        val match = hits.firstOrNull { matches(it) }
        if (match != null) {
            connectInternal(match.address, match.rssi)
        } else {
            lastError = "未发现 ${prefs.devicePrefix} 设备"
            emitStatus()
            scheduleReconnect(lastError)
        }
    }

    /** A scan that never got going: reports `ok=false` to the page, or retries when auto-connecting. */
    private fun failScan(message: String) {
        val auto = autoScan
        val callback = scanDone
        scanDone = null
        autoScan = false
        stopLeScan()
        cancelScanTimer()
        if (link.state == STATE_SCANNING) link = link.copy(state = STATE_IDLE)
        lastError = message
        emitStatus()
        if (auto) {
            scheduleReconnect(message)
        } else {
            callback?.let { done -> main.post { done(false, emptyList()) } }
        }
    }

    private fun stopLeScan(): List<ScanHit> {
        val hits = scanResults.values.toList()
        if (scanning) {
            scanning = false
            val leScanner = scanner
            scanner = null
            if (leScanner != null) runCatching { leScanner.stopScan(scanCallback) }
        }
        return hits
    }

    private fun cancelScanTimer() {
        scanTimer?.let { main.removeCallbacks(it) }
        scanTimer = null
    }

    private fun handleScanResult(result: ScanResult) {
        if (!scanning) return
        val name = runCatching { result.scanRecord?.deviceName ?: result.device.name }.getOrNull().orEmpty()
        val hit = ScanHit(name, result.device.address, result.rssi)
        scanResults[hit.address] = hit
        if (!autoScan) {
            emitScan()
            return
        }
        if (!matches(hit)) return
        // The device is here: stop waiting out the scan timeout and connect now.
        finishScan(report = false)
    }

    private fun matches(hit: ScanHit): Boolean {
        val prefix = prefs.devicePrefix
        return prefix.isEmpty() || hit.name.startsWith(prefix, ignoreCase = true)
    }

    // WebSocket side

    private fun effectiveUrl(): String {
        val base = prefs.bridgeUrl
        val token = prefs.tokenOrCreate()
        if (token.isEmpty()) return base
        return base + (if (base.contains('?')) "&" else "?") + "token=" + token
    }

    private fun openWebSocket() {
        if (!running || link.state != STATE_READY) return
        val existing = ws
        if (existing != null) {
            ws = null
            existing.close()
        }
        val url = effectiveUrl()
        currentWsUrl = url
        if (wsOpenedOnce) stats = stats.copy(reconnects = stats.reconnects + 1)
        val socket = EmbodiedWebSocket(url, wsListener)
        ws = socket
        socket.start()
    }

    private fun closeWebSocket() {
        val socket = ws
        ws = null
        bridgeConnected = false
        wsAttempt = 0
        socket?.close()
    }

    private fun scheduleBridgeReconnect(reason: String) {
        if (!running) return
        bridgeTimer?.let { main.removeCallbacks(it) }
        val delay = BACKOFF_MS[wsAttempt.coerceAtMost(BACKOFF_MS.size - 1)]
        wsAttempt++
        lastError = "桥未连接: $reason"
        val task = Runnable {
            bridgeTimer = null
            worker.execute {
                if (running && !bridgeConnected && ws == null && link.state == STATE_READY) openWebSocket()
            }
        }
        bridgeTimer = task
        main.postDelayed(task, delay)
        emitStatus()
    }

    private val wsListener = object : EmbodiedWebSocket.Listener {
        override fun onOpen(socket: EmbodiedWebSocket) = worker.execute {
            if (!running || ws !== socket) return@execute
            wsOpenedOnce = true
            bridgeConnected = true
            wsAttempt = 0
            lastError = ""
            if (earlyBridge.isNotEmpty()) {
                var sent = 0
                while (earlyBridge.isNotEmpty()) {
                    if (!socket.sendText(earlyBridge.first())) break
                    earlyBridge.removeFirst()
                    sent++
                }
                earlyBridgeBytes = 0
                Log.w(TAG, "flushed $sent early bridge message(s)")
            }
            emitStatus()
        }

        override fun onText(socket: EmbodiedWebSocket, text: String) = worker.execute {
            if (!running || ws !== socket || !bridgeConnected) return@execute
            forwardToBle(EmbodiedFraming.TYPE_TEXT, text.toByteArray(Charsets.UTF_8))
        }

        override fun onBinary(socket: EmbodiedWebSocket, bytes: ByteArray) = worker.execute {
            if (!running || ws !== socket || !bridgeConnected) return@execute
            forwardToBle(EmbodiedFraming.TYPE_BINARY, bytes)
        }

        override fun onClosed(socket: EmbodiedWebSocket, reason: String) = worker.execute {
            if (ws !== socket) return@execute
            ws = null
            bridgeConnected = false
            earlyBridge.clear()
            earlyBridgeBytes = 0
            emitStatus()
            scheduleBridgeReconnect(reason)
        }
    }

    // Framing

    private fun handleUpPacket(packet: ByteArray) {
        val before = reassembler.drops
        val outcome = reassembler.accept(packet, SystemClock.elapsedRealtime())
        val discarded = reassembler.drops - before
        when (outcome) {
            is EmbodiedReassembler.Outcome.Message -> {
                val socket = ws
                if (!bridgeConnected || socket == null) {
                    if (outcome.type == EmbodiedFraming.TYPE_TEXT &&
                        outcome.payload.size <= 4096 &&
                        earlyBridgeBytes + outcome.payload.size <= 8192
                    ) {
                        earlyBridge.addLast(String(outcome.payload, Charsets.UTF_8))
                        earlyBridgeBytes += outcome.payload.size
                        noteDrop("bridge-pending")
                    } else {
                        noteDrop("bridge-not-connected")
                        stats = stats.copy(rxDrop = stats.rxDrop + 1)
                    }
                } else {
                    val sent = if (outcome.type == EmbodiedFraming.TYPE_TEXT) {
                        socket.sendText(String(outcome.payload, Charsets.UTF_8))
                    } else {
                        socket.sendBinary(outcome.payload)
                    }
                    if (sent) {
                        stats = stats.copy(rxBytes = stats.rxBytes + outcome.payload.size)
                    } else {
                        noteDrop("bridge-send-failed")
                        stats = stats.copy(rxDrop = stats.rxDrop + 1)
                    }
                }
            }
            is EmbodiedReassembler.Outcome.Dropped -> noteDrop(outcome.reason)
            EmbodiedReassembler.Outcome.Incomplete -> Unit
        }
        // Messages discarded inside the reassembler (replaced by a new first fragment, timed out)
        // plus the one this packet itself dropped.
        if (discarded > 0) stats = stats.copy(rxDrop = stats.rxDrop + discarded)
    }

    private fun forwardToBle(type: Int, payload: ByteArray) {
        if (!running) return
        if (link.state != STATE_READY || gatt == null || down == null) {
            stats = stats.copy(txDrop = stats.txDrop + 1)
            noteDrop("ble-not-ready")
            return
        }
        val framePayload = link.mtu - 3 - EmbodiedFraming.HEADER_BYTES
        val frames = EmbodiedFraming.encode(type, payload, framePayload)
        if (frames == null) {
            stats = stats.copy(txDrop = stats.txDrop + 1)
            noteDrop(if (payload.size > EmbodiedFraming.maxMessageBytes(type)) "downlink-oversize" else "fragment-limit")
            return
        }
        val frameBytes = frames.sumOf { it.size }
        if (queuedBytes + frameBytes > MAX_TX_QUEUE_BYTES) {
            // The bridge produced data faster than this link drains it; dropping the newest message
            // keeps the queue bounded and the link usable (ADPCM blocks are self-contained, §6.1).
            stats = stats.copy(txDrop = stats.txDrop + 1)
            noteDrop("tx-queue-full")
            return
        }
        txQueue.addAll(frames)
        queuedBytes += frameBytes
        stats = stats.copy(txBytes = stats.txBytes + payload.size)
        pumpTx()
    }

    /**
     * Writes up to [TX_BURST] packets, then yields. `onCharacteristicWrite` continues the queue as
     * soon as the stack reports the burst, and a short timer covers stacks that never report for
     * write-without-response. All of this runs on the GATT executor.
     */
    private fun pumpTx() {
        if (!running || txQueue.isEmpty()) return
        var sent = 0
        while (sent < TX_BURST && txQueue.isNotEmpty()) {
            val frame = txQueue.first()
            if (!writeFragment(frame)) break
            txQueue.removeFirst()
            queuedBytes -= frame.size
            sent++
        }
        if (txQueue.isNotEmpty() && !txWakeupScheduled) {
            txWakeupScheduled = true
            main.postDelayed(txWakeup, TX_PACE_MS)
        }
    }

    @Suppress("DEPRECATION")
    private fun writeFragment(frame: ByteArray): Boolean {
        val currentGatt = gatt ?: return false
        val characteristic = down ?: return false
        characteristic.value = frame
        characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        return try {
            currentGatt.writeCharacteristic(characteristic)
        } catch (_: SecurityException) {
            false
        }
    }

    // GATT callbacks: every entry is handed to the single executor before touching state.

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            worker.execute {
                if (!running || g !== gatt) {
                    runCatching { g.close() }
                    return@execute
                }
                if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                    onGattConnected(g)
                } else {
                    onGattLost(g, "蓝牙连接断开 (status=$status state=$newState)")
                }
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            worker.execute {
                if (g !== gatt) return@execute
                handleMtuChanged(g, mtu, status)
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            worker.execute {
                if (g !== gatt) return@execute
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    onGattLost(g, "服务发现失败 (status=$status)")
                } else {
                    onServicesDiscovered(g)
                }
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            worker.execute {
                if (g !== gatt || descriptor.uuid != CCCD_UUID) return@execute
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    onGattLost(g, "开启通知失败 (status=$status)")
                } else {
                    Log.w(TAG, "cccd written, going ready (mtu=$negotiatedMtu)")
                    onGattReady(g)
                }
            }
        }

        override fun onReadRemoteRssi(g: BluetoothGatt, rssi: Int, status: Int) {
            worker.execute {
                if (g === gatt && status == BluetoothGatt.GATT_SUCCESS) {
                    link = link.copy(rssi = rssi)
                    emitStatus()
                }
            }
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (characteristic.uuid != UP_UUID) return
            // The stack may reuse the characteristic's buffer after this callback returns; copy
            // before handing the packet to the executor.
            val value = characteristic.value?.copyOf() ?: return
            worker.execute {
                if (g === gatt) handleUpPacket(value)
            }
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            if (characteristic.uuid != DOWN_UUID) return
            worker.execute {
                if (g === gatt) {
                    if (status == BluetoothGatt.GATT_SUCCESS) pumpTx()
                    else onGattLost(g, "BLE 写入失败 (status=$status)")
                }
            }
        }
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            worker.execute { handleScanResult(result) }
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
            results.forEach { result -> worker.execute { handleScanResult(result) } }
        }

        override fun onScanFailed(errorCode: Int) {
            worker.execute { failScan("扫描失败 (code=$errorCode)") }
        }
    }

    // Reporting

    private fun emitStatus() = emit(mapOf("type" to "status", "status" to snapshot()))

    private fun emitScan() = emit(mapOf("type" to "scan", "devices" to scanResults.values.map { it.toWire() }))

    private fun noteDrop(reason: String) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastDropLogAt < DROP_LOG_INTERVAL_MS) return
        lastDropLogAt = now
        emitLog("丢弃: $reason")
    }

    private fun emitLog(line: String) {
        Log.w(TAG, line)
        emit(mapOf("type" to "log", "line" to line))
    }

    private fun emit(event: Map<String, Any?>) {
        main.post {
            for (listener in listeners) runCatching { listener.onEvent(event) }
        }
    }

    private fun failHere(message: String) {
        lastError = message
        emitStatus()
    }

    private fun hasLocationPermission(): Boolean =
        context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun cancelTimers() {
        reconnectTimer?.let { main.removeCallbacks(it) }
        reconnectTimer = null
        bridgeTimer?.let { main.removeCallbacks(it) }
        bridgeTimer = null
        main.removeCallbacks(txWakeup)
        txWakeupScheduled = false
    }

    private data class BleLink(
        val state: String = STATE_IDLE,
        val name: String? = null,
        val address: String? = null,
        val rssi: Int = 0,
        val mtu: Int = 0,
    )

    private data class Stats(
        val txBytes: Long = 0L,
        val rxBytes: Long = 0L,
        val txDrop: Int = 0,
        val rxDrop: Int = 0,
        val reconnects: Int = 0,
    )

    private data class ScanHit(val name: String, val address: String, val rssi: Int) {
        fun toWire(): Map<String, Any?> = mapOf("name" to name, "address" to address, "rssi" to rssi)
    }

    companion object {
        const val STATE_IDLE = "idle"
        const val STATE_SCANNING = "scanning"
        const val STATE_CONNECTING = "connecting"
        const val STATE_READY = "ready"
        private const val TAG = "DshEmbodied"

        private val SERVICE_UUID: UUID = UUID.fromString("6a696e67-6a69-6e67-8000-000000000001")
        private val DOWN_UUID: UUID = UUID.fromString("6a696e67-6a69-6e67-8000-000000000002")
        private val UP_UUID: UUID = UUID.fromString("6a696e67-6a69-6e67-8000-000000000003")
        private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        private const val REQUESTED_MTU = 247
        /** Enough for a 16 KiB message within 255 fragments (protocol §4). */
        private const val MIN_MTU = 100
        private const val TX_BURST = 4
        private const val TX_PACE_MS = 12L
        private const val MAX_TX_QUEUE_BYTES = 256 * 1024
        private const val MAX_SCAN_MS = 30_000L
        private const val MIN_SCAN_MS = 500L
        private const val DEFAULT_SCAN_MS = 10_000L
        private const val DROP_LOG_INTERVAL_MS = 1_000L
        private val BACKOFF_MS = longArrayOf(1_000L, 2_000L, 5_000L, 10_000L)

        @Volatile private var instance: EmbodiedGateway? = null

        fun get(context: Context): EmbodiedGateway =
            instance ?: synchronized(this) {
                instance ?: EmbodiedGateway(context.applicationContext).also { instance = it }
            }
    }
}
