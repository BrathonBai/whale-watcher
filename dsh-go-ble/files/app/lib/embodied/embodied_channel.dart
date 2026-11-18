// Dart side of the `dsh/embodied_ble` platform channels (Kotlin
// `EmbodiedBlePlugin`): the 鲸鲸 BLE gateway's snapshot, its stored config and
// the operations the settings page offers. The wire contract is frozen in
// docs/蓝牙直连dsh-go-设计与协议-2026-11-13.md §10.3 — method names, reply
// shapes and status fields must stay exactly as written there.
//
// Deliberately plain: no formatting, no localized text (that is
// embodied_strings.dart) and no Riverpod (that is embodied_state.dart), so the
// protocol can be read in one place.

import 'dart:async';

import 'package:flutter/services.dart';

/// Why a call to the native gateway failed.
enum EmbodiedErrorKind {
  /// This build has no native side (an older APK, a host desktop build, a test).
  missingPlugin,

  /// The native side answered with an error; [EmbodiedException.detail] says why.
  platform,

  /// The native side answered with something this side cannot read.
  badReply,
}

/// A failed gateway call. Never swallowed: the page shows one sentence of its
/// own, then [detail]. [toString] is for logs, not for the screen.
class EmbodiedException implements Exception {
  const EmbodiedException(this.kind, [this.detail = '']);

  final EmbodiedErrorKind kind;

  /// The native error message/code, or a short note about a bad reply.
  final String detail;

  @override
  String toString() => detail.isEmpty ? 'EmbodiedException(${kind.name})' : 'EmbodiedException(${kind.name}): $detail';
}

/// Status `service`: the gateway's foreground service.
enum EmbodiedServicePhase {
  stopped,
  starting,
  running,
  stopping;

  static EmbodiedServicePhase parse(Object? wire) => switch (wire) {
    'starting' => starting,
    'running' => running,
    'stopping' => stopping,
    _ => stopped,
  };
}

/// Status `adapter`: this phone's Bluetooth adapter.
enum EmbodiedAdapterState {
  on,
  off,
  missing;

  static EmbodiedAdapterState parse(Object? wire) => switch (wire) {
    'on' => on,
    'off' => off,
    _ => missing,
  };
}

/// Status `permission`: whether the runtime permissions a scan needs are granted.
enum EmbodiedPermissionState {
  granted,
  missing,
  denied;

  static EmbodiedPermissionState parse(Object? wire) => switch (wire) {
    'granted' => granted,
    'denied' => denied,
    _ => missing,
  };
}

/// Status `engine`: the local DSH engine, which the gateway lives beside.
enum EmbodiedEngineState {
  unknown,
  stopped,
  running;

  static EmbodiedEngineState parse(Object? wire) => switch (wire) {
    'stopped' => stopped,
    'running' => running,
    _ => unknown,
  };
}

/// Status `ble.state`: where the BLE link stands.
enum EmbodiedBleState {
  idle,
  scanning,
  connecting,
  ready;

  static EmbodiedBleState parse(Object? wire) => switch (wire) {
    'scanning' => scanning,
    'connecting' => connecting,
    'ready' => ready,
    _ => idle,
  };
}

/// One device, from a scan (`name,address,rssi`) or the connected one
/// (`name,address,rssi,mtu`).
class EmbodiedDevice {
  const EmbodiedDevice({required this.name, required this.address, required this.rssi, this.mtu});

  factory EmbodiedDevice.fromMap(Map<Object?, Object?> map) => EmbodiedDevice(
    name: map['name'] as String? ?? '',
    address: map['address'] as String? ?? '',
    rssi: (map['rssi'] as num?)?.toInt() ?? 0,
    mtu: (map['mtu'] as num?)?.toInt(),
  );

  /// `Jingjing-XXXX` as the device advertises it; empty is possible.
  final String name;

  /// BLE MAC, `AA:BB:...`; the address connect() takes.
  final String address;

  /// dBm; 0 while unknown.
  final int rssi;

  /// Negotiated ATT MTU, only on the connected device.
  final int? mtu;
}

/// Status `ble`: the link, its device and the packet counters.
class EmbodiedBleStatus {
  const EmbodiedBleStatus({
    this.state = EmbodiedBleState.idle,
    this.device,
    this.txBytes = 0,
    this.rxBytes = 0,
    this.txDrop = 0,
    this.rxDrop = 0,
  });

  factory EmbodiedBleStatus.fromMap(Map<Object?, Object?> map) {
    final device = _mapOrNull(map['device']);
    return EmbodiedBleStatus(
      state: EmbodiedBleState.parse(map['state']),
      device: device == null ? null : EmbodiedDevice.fromMap(device),
      txBytes: (map['txBytes'] as num?)?.toInt() ?? 0,
      rxBytes: (map['rxBytes'] as num?)?.toInt() ?? 0,
      txDrop: (map['txDrop'] as num?)?.toInt() ?? 0,
      rxDrop: (map['rxDrop'] as num?)?.toInt() ?? 0,
    );
  }

  final EmbodiedBleState state;
  final EmbodiedDevice? device;

  /// Phone → device payload bytes.
  final int txBytes;

  /// Device → phone payload bytes.
  final int rxBytes;

  /// Frames the device side could not take (write without response ran ahead).
  final int txDrop;

  /// Frames dropped on receive (framing errors, unknown types).
  final int rxDrop;
}

/// Status `bridge`: the mobile-side WS client and how often it reconnected.
class EmbodiedBridgeStatus {
  const EmbodiedBridgeStatus({this.url = '', this.connected = false, this.reconnects = 0});

  factory EmbodiedBridgeStatus.fromMap(Map<Object?, Object?> map) => EmbodiedBridgeStatus(
    url: map['url'] as String? ?? '',
    connected: map['connected'] == true,
    reconnects: (map['reconnects'] as num?)?.toInt() ?? 0,
  );

  final String url;
  final bool connected;

  /// Reconnect attempts since the service started.
  final int reconnects;
}

/// The `status` snapshot (§10.3). Every unknown wire value falls back to a
/// conservative default, so a newer native side never crashes the page.
class EmbodiedStatus {
  const EmbodiedStatus({
    this.service = EmbodiedServicePhase.stopped,
    this.enabled = false,
    this.adapter = EmbodiedAdapterState.missing,
    this.permission = EmbodiedPermissionState.missing,
    this.engine = EmbodiedEngineState.unknown,
    this.ble = const EmbodiedBleStatus(),
    this.bridge = const EmbodiedBridgeStatus(),
    this.lastError = '',
  });

  factory EmbodiedStatus.fromMap(Map<Object?, Object?> map) {
    final ble = _mapOrNull(map['ble']);
    final bridge = _mapOrNull(map['bridge']);
    return EmbodiedStatus(
      service: EmbodiedServicePhase.parse(map['service']),
      enabled: map['enabled'] == true,
      adapter: EmbodiedAdapterState.parse(map['adapter']),
      permission: EmbodiedPermissionState.parse(map['permission']),
      engine: EmbodiedEngineState.parse(map['engine']),
      ble: ble == null ? const EmbodiedBleStatus() : EmbodiedBleStatus.fromMap(ble),
      bridge: bridge == null ? const EmbodiedBridgeStatus() : EmbodiedBridgeStatus.fromMap(bridge),
      lastError: map['lastError'] as String? ?? '',
    );
  }

  final EmbodiedServicePhase service;

  /// The user's switch: the gateway starts when the engine is ready.
  final bool enabled;
  final EmbodiedAdapterState adapter;
  final EmbodiedPermissionState permission;
  final EmbodiedEngineState engine;
  final EmbodiedBleStatus ble;
  final EmbodiedBridgeStatus bridge;

  /// The last error the native side saw; empty when there is none.
  final String lastError;
}

/// The `config` reply (§10.3) and what `configure` writes.
class EmbodiedConfig {
  const EmbodiedConfig({
    this.bridgeUrl = defaultBridgeUrl,
    this.autoConnect = true,
    this.devicePrefix = defaultDevicePrefix,
    this.enabled = false,
  });

  factory EmbodiedConfig.fromMap(Map<Object?, Object?> map) => EmbodiedConfig(
    bridgeUrl: map['bridgeUrl'] as String? ?? defaultBridgeUrl,
    autoConnect: map['autoConnect'] != false,
    devicePrefix: map['devicePrefix'] as String? ?? defaultDevicePrefix,
    enabled: map['enabled'] == true,
  );

  static const defaultBridgeUrl = 'ws://127.0.0.1:7788/device';
  static const defaultDevicePrefix = 'Jingjing-';

  /// The embedded bridge's address (the engine's own localhost).
  final String bridgeUrl;

  /// Reconnect to the last device by itself on start.
  final bool autoConnect;

  /// Devices whose name starts with this show up in the scan list.
  final String devicePrefix;

  /// Persisted copy of the page's switch (the switch itself calls start/stop).
  final bool enabled;

  /// A `ws://`/`wss://` URL with a host: what the native side can dial.
  static bool isValidBridgeUrl(String value) {
    final uri = Uri.tryParse(value.trim());
    if (uri == null || (uri.scheme != 'ws' && uri.scheme != 'wss')) return false;
    return uri.host.isNotEmpty;
  }
}

/// What `start` answered: whether it works now, and (when it does not) which
/// runtime permissions to ask for.
class EmbodiedStartResult {
  const EmbodiedStartResult({required this.ok, this.needPermission = const [], this.status});

  final bool ok;

  /// Android permission names, e.g. `ACCESS_FINE_LOCATION`; empty on success.
  final List<String> needPermission;

  /// A fresh snapshot, when the native side answered with one.
  final EmbodiedStatus? status;
}

/// One event from `dsh/embodied_ble/events`.
sealed class EmbodiedEvent {
  const EmbodiedEvent();

  /// Null for a type this build does not know (forward compatibility).
  static EmbodiedEvent? parse(Map<Object?, Object?> raw) {
    switch (raw['type']) {
      case 'status':
        final status = _mapOrNull(raw['status']);
        return status == null ? null : EmbodiedStatusEvent(EmbodiedStatus.fromMap(status));
      case 'scan':
        return EmbodiedScanEvent(_devices(raw['devices']));
      case 'log':
        final line = raw['line'] as String?;
        return line == null || line.isEmpty ? null : EmbodiedLogEvent(line);
    }
    return null;
  }
}

/// A status snapshot pushed by the native side.
class EmbodiedStatusEvent extends EmbodiedEvent {
  const EmbodiedStatusEvent(this.status);

  final EmbodiedStatus status;
}

/// Scan results that arrived after `scan` returned already.
class EmbodiedScanEvent extends EmbodiedEvent {
  const EmbodiedScanEvent(this.devices);

  final List<EmbodiedDevice> devices;
}

/// One diagnostic line (also shown on the page's last line).
class EmbodiedLogEvent extends EmbodiedEvent {
  const EmbodiedLogEvent(this.line);

  final String line;
}

/// Dart side of the two channels named in §10.3.
class EmbodiedChannel {
  EmbodiedChannel();

  static const _methods = MethodChannel('dsh/embodied_ble');
  static const _events = EventChannel('dsh/embodied_ble/events');

  /// Whether the native side is registered at all. Cached: a plugin does not
  /// appear while the app runs, and the event stream must not be touched
  /// before this has answered (EventChannel reports a missing registration
  /// through FlutterError, not through the stream).
  Future<bool>? _available;

  Future<bool> available() => _available ??= _probe();

  Future<bool> _probe() async {
    try {
      await _invoke('status');
      return true;
    } on EmbodiedException catch (error) {
      return error.kind != EmbodiedErrorKind.missingPlugin;
    }
  }

  Stream<EmbodiedEvent> get events async* {
    if (!await available()) return;
    yield* _events
        .receiveBroadcastStream()
        .map<EmbodiedEvent?>((raw) => raw is Map ? EmbodiedEvent.parse(Map<Object?, Object?>.from(raw)) : null)
        .where((event) => event != null)
        .cast<EmbodiedEvent>();
  }

  /// `{status: {...}}`.
  Future<EmbodiedStatus> status() async {
    final reply = await _invoke('status');
    final status = _mapOrNull(reply['status']);
    if (status == null) throw const EmbodiedException(EmbodiedErrorKind.badReply, 'status: no snapshot');
    return EmbodiedStatus.fromMap(status);
  }

  /// `{ok, needPermission?, status}`.
  Future<EmbodiedStartResult> start() async {
    final reply = await _invoke('start');
    final status = _mapOrNull(reply['status']);
    return EmbodiedStartResult(
      ok: reply['ok'] == true,
      needPermission: _strings(reply['needPermission']),
      status: status == null ? null : EmbodiedStatus.fromMap(status),
    );
  }

  Future<void> stop() => _expectOk('stop');

  /// `{ok, devices}`.
  Future<List<EmbodiedDevice>> scan({int? timeoutMs}) async {
    final reply = await _invoke('scan', {if (timeoutMs != null) 'timeoutMs': timeoutMs});
    if (reply['ok'] != true) throw const EmbodiedException(EmbodiedErrorKind.platform);
    return _devices(reply['devices']);
  }

  Future<void> connect(String address) => _expectOk('connect', {'address': address});

  Future<void> disconnect() => _expectOk('disconnect');

  /// `{config}`.
  Future<EmbodiedConfig> config() async {
    final reply = await _invoke('config');
    return _configOf(reply, 'config');
  }

  /// `{ok, config}`; only the given fields change.
  Future<EmbodiedConfig> configure({
    String? bridgeUrl,
    bool? autoConnect,
    String? devicePrefix,
    bool? enabled,
  }) async {
    final reply = await _invoke('configure', {
      if (bridgeUrl != null) 'bridgeUrl': bridgeUrl,
      if (autoConnect != null) 'autoConnect': autoConnect,
      if (devicePrefix != null) 'devicePrefix': devicePrefix,
      if (enabled != null) 'enabled': enabled,
    });
    if (reply['ok'] != true) throw const EmbodiedException(EmbodiedErrorKind.platform);
    return _configOf(reply, 'configure');
  }

  Future<void> openSystemBluetooth() => _expectOk('openSystemBluetooth');

  Future<void> _expectOk(String method, [Map<String, Object?>? arguments]) async {
    final reply = await _invoke(method, arguments);
    if (reply['ok'] == true) return;
    // The frozen reply has no message; the native side put its reason in
    // `status.lastError`, which the state layer reads into the error.
    throw const EmbodiedException(EmbodiedErrorKind.platform);
  }

  Future<Map<Object?, Object?>> _invoke(String method, [Map<String, Object?>? arguments]) async {
    try {
      final reply = await _methods.invokeMapMethod<Object?, Object?>(method, arguments);
      if (reply == null) throw EmbodiedException(EmbodiedErrorKind.badReply, '$method: empty reply');
      return reply;
    } on MissingPluginException {
      throw const EmbodiedException(EmbodiedErrorKind.missingPlugin);
    } on PlatformException catch (error) {
      throw EmbodiedException(EmbodiedErrorKind.platform, _platformDetail(error));
    }
  }

  static EmbodiedConfig _configOf(Map<Object?, Object?> reply, String method) {
    final config = _mapOrNull(reply['config']);
    if (config == null) throw EmbodiedException(EmbodiedErrorKind.badReply, '$method: no config');
    return EmbodiedConfig.fromMap(config);
  }
}

String _platformDetail(PlatformException error) {
  final message = error.message?.trim() ?? '';
  return message.isEmpty ? error.code : message;
}

Map<Object?, Object?>? _mapOrNull(Object? raw) => raw is Map ? Map<Object?, Object?>.from(raw) : null;

List<String> _strings(Object? raw) => raw is List
    ? [
        for (final value in raw)
          if (value is String && value.isNotEmpty) value,
      ]
    : const [];

List<EmbodiedDevice> _devices(Object? raw) => raw is List
    ? [
        for (final value in raw)
          if (value is Map) EmbodiedDevice.fromMap(Map<Object?, Object?>.from(value)),
      ]
    : const [];
