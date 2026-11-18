// Chinese/English text for the 鲸鲸蓝牙 settings page.
//
// v1 does not go through the ARB/l10n generation chain (no Flutter on the
// machine that wrote it, so `l10n_merge.py` + gen-l10n could not run): every
// string lives here twice and is picked by language. **Move these to
// lib/l10n/parts/*.arb when a Flutter machine is at hand** — the keys map
// one-to-one, and `spots.dart` reads its titles from the same place so search
// and the page cannot drift apart.
//
// The language is the app's own text language (the generated L10n's
// `localeName`), so the page and its index entry always agree.
import 'package:flutter/widgets.dart';

import '../l10n/l10n.dart';
import 'embodied_channel.dart';

/// Every string the page and its index entry show, in the app language.
class EmbodiedStrings {
  const EmbodiedStrings._(this.zh);

  /// True for any Chinese locale (`zh`, `zh_CN`).
  final bool zh;

  static EmbodiedStrings of(BuildContext context) => ofL10n(context.l10n);

  /// For the settings index, which resolves titles through [L10n].
  static EmbodiedStrings ofL10n(L10n l10n) => ofLanguage(l10n.localeName);

  static EmbodiedStrings ofLanguage(String languageCode) => EmbodiedStrings._(
    languageCode.toLowerCase().startsWith('zh'),
  );

  String _pick(String chinese, String english) => zh ? chinese : english;

  // ── The page and its index entry ──────────────────────────────────────────

  String get pageTitle => _pick('鲸鲸蓝牙', 'Jingjing Bluetooth');

  /// Search synonyms, comma-separated, as `SettingsPageMeta.keywords` wants.
  String get pageKeywords => _pick('鲸鲸,蓝牙,ble,设备,直连', 'jingjing,bluetooth,ble,device,direct');

  // ── Headings ──────────────────────────────────────────────────────────────

  String get sectionStatus => _pick('状态', 'Status');
  String get sectionLink => _pick('蓝牙对接', 'Bluetooth link');
  String get sectionDevices => _pick('设备', 'Devices');
  String get sectionAdvanced => _pick('高级', 'Advanced');
  String get sectionDiagnostics => _pick('诊断', 'Diagnostics');

  // ── Rows (titles are the index's, so search names them the same way) ──────

  String get titleEnable => _pick('启用蓝牙对接', 'Bluetooth link');
  String get keywordsEnable => _pick('启用,开关,网关,ble', 'enable,switch,gateway,ble');

  String get titleScan => _pick('扫描设备', 'Scan for devices');
  String get keywordsScan => _pick('扫描,搜索,附近,设备', 'scan,search,nearby,devices');

  String get titleConnection => _pick('设备连接', 'Device link');
  String get keywordsConnection => _pick('连接,断开,配对', 'connect,disconnect,pair');

  String get titleAutoConnect => _pick('自动连接', 'Auto-connect');
  String get keywordsAutoConnect => _pick('自动连接,重连,上次', 'auto,reconnect,last');

  String get titleBridgeUrl => _pick('桥地址', 'Bridge address');
  String get keywordsBridgeUrl => _pick('桥,地址,端口,ws', 'bridge,address,url,port');

  String get titleDevicePrefix => _pick('设备名前缀', 'Device name prefix');
  String get keywordsDevicePrefix => _pick('设备名,前缀,过滤', 'device,name,prefix,filter');

  String get titleOpenBluetooth => _pick('打开系统蓝牙设置', 'Open Bluetooth settings');
  String get keywordsOpenBluetooth => _pick('系统设置,蓝牙,权限', 'system,settings,bluetooth,permission');

  String get titleRefresh => _pick('刷新状态', 'Refresh status');
  String get keywordsRefresh => _pick('刷新,状态,重试', 'refresh,status,retry');

  // ── Status card ───────────────────────────────────────────────────────────

  String get labelService => _pick('服务', 'Service');
  String get labelBluetooth => _pick('蓝牙', 'Bluetooth');
  String get labelPermission => _pick('权限', 'Permission');
  String get labelEngine => _pick('引擎', 'Engine');
  String get labelDevice => _pick('设备', 'Device');
  String get labelBridge => _pick('桥连接', 'Bridge');
  String get labelLastError => _pick('最近错误', 'Last error');

  String get labelTxBytes => _pick('发送', 'Sent');
  String get labelRxBytes => _pick('接收', 'Received');
  String get labelTxDrop => _pick('发送丢帧', 'Dropped (TX)');
  String get labelRxDrop => _pick('接收丢帧', 'Dropped (RX)');
  String get labelReconnects => _pick('桥重连', 'Bridge reconnects');

  String service(EmbodiedServicePhase phase) => switch (phase) {
    EmbodiedServicePhase.stopped => _pick('已停止', 'Stopped'),
    EmbodiedServicePhase.starting => _pick('启动中', 'Starting'),
    EmbodiedServicePhase.running => _pick('运行中', 'Running'),
    EmbodiedServicePhase.stopping => _pick('停止中', 'Stopping'),
  };

  String adapter(EmbodiedAdapterState state) => switch (state) {
    EmbodiedAdapterState.on => _pick('已开启', 'On'),
    EmbodiedAdapterState.off => _pick('已关闭', 'Off'),
    EmbodiedAdapterState.missing => _pick('没有蓝牙', 'No adapter'),
  };

  String permission(EmbodiedPermissionState state) => switch (state) {
    EmbodiedPermissionState.granted => _pick('已授权', 'Granted'),
    EmbodiedPermissionState.missing => _pick('未申请', 'Not requested'),
    EmbodiedPermissionState.denied => _pick('已拒绝', 'Denied'),
  };

  String engine(EmbodiedEngineState state) => switch (state) {
    EmbodiedEngineState.unknown => _pick('未知', 'Unknown'),
    EmbodiedEngineState.stopped => _pick('未运行', 'Stopped'),
    EmbodiedEngineState.running => _pick('运行中', 'Running'),
  };

  String bleState(EmbodiedBleState state) => switch (state) {
    EmbodiedBleState.idle => _pick('空闲', 'Idle'),
    EmbodiedBleState.scanning => _pick('扫描中', 'Scanning'),
    EmbodiedBleState.connecting => _pick('连接中', 'Connecting'),
    EmbodiedBleState.ready => _pick('已连接', 'Connected'),
  };

  /// Device line: name (or address) · RSSI · MTU.
  String deviceLine(EmbodiedBleStatus ble) {
    final device = ble.device;
    if (device == null) return notConnected;
    final name = device.name.isEmpty ? device.address : device.name;
    final mtu = device.mtu;
    return [name, formatRssi(device.rssi), if (mtu != null) 'MTU $mtu'].join(' · ');
  }

  /// Bridge line: its link state and the address it dials.
  String bridgeLine(EmbodiedBridgeStatus bridge) {
    final url = bridge.url.isEmpty ? EmbodiedConfig.defaultBridgeUrl : bridge.url;
    return '${bridge.connected ? connected : notConnected} · $url';
  }

  // ── Values ────────────────────────────────────────────────────────────────

  String get on => _pick('开', 'On');
  String get off => _pick('关', 'Off');
  String get connected => _pick('已连接', 'Connected');
  String get notConnected => _pick('未连接', 'Not connected');
  String get none => _pick('无', 'None');
  String get loading => _pick('读取中…', 'Loading…');
  String get unavailable => _pick('不可用', 'Unavailable');
  String get scanning => _pick('扫描中…', 'Scanning…');

  String formatRssi(int rssi) => '$rssi dBm';

  /// 0 B / 1.5 KB / 2.0 MB (payload counters).
  String formatBytes(int count) {
    if (count < 1024) return '$count B';
    if (count < 1024 * 1024) return '${(count / 1024).toStringAsFixed(1)} KB';
    return '${(count / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  // ── Hints and footnotes ───────────────────────────────────────────────────

  String get enableSubtitle => _pick(
    '手机作为网关，把鲸鲸的消息转给本机的大脑桥',
    'This phone relays Jingjing to the local bridge',
  );

  String get scanHint => _pick('约 10 秒；鲸鲸要开机并在附近', 'About 10 seconds; keep Jingjing on and nearby');
  String get noDevicesYet => _pick('还没发现设备', 'No devices found yet');
  String get connectHint => _pick('点下面的设备连接', 'Tap a device below to connect');
  String get disconnectHint => _pick('点此断开', 'Tap to disconnect');
  String get autoConnectSubtitle => _pick('启动后自动连回上次的设备', 'Reconnect to the last device on start');
  String get devicePrefixSubtitle => _pick('只显示名字以此开头的设备', 'Only list devices whose name starts with this');
  String get bridgeUrlHint => EmbodiedConfig.defaultBridgeUrl;
  String get devicePrefixHint => EmbodiedConfig.defaultDevicePrefix;

  String get unsupportedHint => _pick(
    '这个构建没有蓝牙网关的原生实现，页面只显示当前值。',
    'This build has no native Bluetooth gateway; the page only shows values.',
  );

  /// What to do about `start`'s `needPermission`.
  String permissionHint(List<String> needPermission) => needPermission.isEmpty
      ? ''
      : _pick(
          '缺少权限：${needPermission.join('、')}。请在系统弹窗里允许；若已经拒绝，去系统设置里给本应用打开蓝牙与位置权限后重试。',
          'Missing permissions: ${needPermission.join(', ')}. Allow them in the system prompt; if denied, '
              'grant Bluetooth and location access to this app in system settings, then retry.',
        );

  String get invalidBridgeUrl => _pick(
    '桥地址要以 ws:// 或 wss:// 开头，并带主机名',
    'The bridge address must start with ws:// or wss:// and name a host',
  );

  String get invalidDevicePrefix => _pick('设备名前缀不能为空', 'The device name prefix cannot be empty');

  /// One sentence for a failed call; the native detail follows when it has one.
  String errorText(EmbodiedException error) => switch (error.kind) {
    EmbodiedErrorKind.missingPlugin => unsupportedHint,
    EmbodiedErrorKind.badReply => _detail(_pick('原生实现返回了无法识别的内容', 'The native side answered unusably'), error.detail),
    EmbodiedErrorKind.platform => _detail(_pick('操作失败', 'Operation failed'), error.detail),
  };

  String _detail(String head, String detail) => detail.isEmpty ? head : '$head${zh ? '：' : ': '}$detail';
}
