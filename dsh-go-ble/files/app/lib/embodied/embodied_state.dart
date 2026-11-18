// Riverpod state for the 鲸鲸蓝牙 page: the native gateway's snapshot stream,
// the stored config and the operations the page offers, in one place so the
// page reads like every other settings page (compare runtime_state.dart).

import 'dart:async';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'embodied_channel.dart';

/// Builds the native gateway. Tests replace this with a channel that answers at
/// once (`test/support/quiet_embodied.dart`): a widget test has no platform
/// side, and a real message round trip would leave the page's first status
/// unresolved for the length of the test.
@visibleForTesting
EmbodiedChannel Function() createEmbodiedChannel = EmbodiedChannel.new;

/// The native gateway. One instance is enough: it holds no state of its own.
final embodiedChannelProvider = Provider<EmbodiedChannel>((ref) => createEmbodiedChannel());

/// The stored gateway settings (`config`); invalidated after every `configure`
/// so the page reads what the native side actually kept.
///
/// Without a native side the defaults are what the app would have written
/// anyway, so the page shows them instead of an error (and tests, which have no
/// platform side, get a settled future rather than a failing one).
final embodiedConfigProvider = FutureProvider<EmbodiedConfig>((ref) async {
  try {
    return await ref.watch(embodiedChannelProvider).config();
  } on EmbodiedException catch (error) {
    if (error.kind == EmbodiedErrorKind.missingPlugin) return const EmbodiedConfig();
    rethrow;
  }
});

/// What the page shows: the last status snapshot, the last scan, what is in
/// flight, and the last error. Nothing is swallowed — a failed operation always
/// leaves [error] for the page to show.
class EmbodiedUiState {
  const EmbodiedUiState({
    this.status,
    this.devices = const [],
    this.loaded = false,
    this.unsupported = false,
    this.busy = false,
    this.scanning = false,
    this.needPermission = const [],
    this.error,
    this.logs = const [],
  });

  /// Null until the first snapshot arrives (or forever without a native side).
  final EmbodiedStatus? status;
  final List<EmbodiedDevice> devices;

  /// False until the first `status` attempt finished, successfully or not.
  final bool loaded;

  /// This build has no native gateway: the page says so instead of pretending.
  final bool unsupported;

  /// One operation at a time (start, stop, scan, connect, configure).
  final bool busy;

  /// The scan in progress (a subset of [busy], for the row's spinner).
  final bool scanning;

  /// From `start`: runtime permissions still missing.
  final List<String> needPermission;

  /// The last failed operation, shown until the next one starts.
  final EmbodiedException? error;

  /// The latest diagnostic lines, oldest first, at most 20.
  final List<String> logs;

  bool get enabled => status?.enabled ?? false;
  bool get connected => status?.ble.device != null;
  bool get adapterOn => status?.adapter == EmbodiedAdapterState.on;

  EmbodiedUiState copyWith({
    EmbodiedStatus? status,
    List<EmbodiedDevice>? devices,
    bool? loaded,
    bool? unsupported,
    bool? busy,
    bool? scanning,
    List<String>? needPermission,
    EmbodiedException? error,
    bool clearError = false,
    List<String>? logs,
  }) => EmbodiedUiState(
    status: status ?? this.status,
    devices: devices ?? this.devices,
    loaded: loaded ?? this.loaded,
    unsupported: unsupported ?? this.unsupported,
    busy: busy ?? this.busy,
    scanning: scanning ?? this.scanning,
    needPermission: needPermission ?? this.needPermission,
    error: clearError ? null : (error ?? this.error),
    logs: logs ?? this.logs,
  );
}

class EmbodiedController extends Notifier<EmbodiedUiState> {
  static const _maxLogs = 20;

  @override
  EmbodiedUiState build() {
    final channel = ref.watch(embodiedChannelProvider);
    final subscription = channel.events.listen(_onEvent, onError: (Object _) {});
    ref.onDispose(() => unawaited(subscription.cancel()));
    unawaited(_load(channel));
    return const EmbodiedUiState();
  }

  EmbodiedChannel get _channel => ref.read(embodiedChannelProvider);

  Future<void> _load(EmbodiedChannel channel) async {
    try {
      final status = await channel.status();
      if (ref.mounted) state = state.copyWith(status: status, loaded: true, unsupported: false);
    } on EmbodiedException catch (error) {
      if (!ref.mounted) return;
      // A missing native side is a fact about this build, not a failed action:
      // the page shows the unsupported hint instead of an error banner.
      state = error.kind == EmbodiedErrorKind.missingPlugin
          ? state.copyWith(loaded: true, unsupported: true, clearError: true)
          : state.copyWith(loaded: true, unsupported: false, error: error);
    }
  }

  void _onEvent(EmbodiedEvent event) {
    if (!ref.mounted) return;
    switch (event) {
      case EmbodiedStatusEvent(:final status):
        state = state.copyWith(status: status, loaded: true, unsupported: false);
      case EmbodiedScanEvent(:final devices):
        state = state.copyWith(devices: devices, scanning: false);
      case EmbodiedLogEvent(:final line):
        final logs = [...state.logs, line];
        state = state.copyWith(logs: logs.length <= _maxLogs ? logs : logs.sublist(logs.length - _maxLogs));
    }
  }

  /// Runs one operation with the page's busy/error feedback around it.
  Future<void> _run(Future<void> Function() action) async {
    if (state.busy) return;
    state = state.copyWith(busy: true, clearError: true);
    try {
      await action();
    } on EmbodiedException catch (error) {
      if (ref.mounted) {
        // `{ok:false}` replies carry no message (§10.3); the native side's own
        // sentence is in `status.lastError`, so a failed connect or scan still
        // says why instead of "failed".
        final detail = error.detail.isEmpty ? (state.status?.lastError ?? '') : error.detail;
        state = state.copyWith(
          error: EmbodiedException(error.kind, detail),
          unsupported: error.kind == EmbodiedErrorKind.missingPlugin,
        );
      }
    } finally {
      if (ref.mounted) state = state.copyWith(busy: false, scanning: false);
    }
  }

  void clearError() {
    if (state.error != null) state = state.copyWith(clearError: true);
  }

  /// Reads the snapshot again (the page's 刷新状态).
  Future<void> refresh() async {
    clearError();
    await _load(_channel);
  }

  /// The page's switch: `start` asks for the permissions, `stop` lets the
  /// service and the link go.
  Future<void> setEnabled(bool enabled) => _run(() async {
    if (enabled) {
      final result = await _channel.start();
      if (!result.ok && result.needPermission.isEmpty) {
        // The native side's own sentence (no adapter, adapter off, foreground
        // service refused) is what the person needs to read.
        throw EmbodiedException(EmbodiedErrorKind.platform, result.status?.lastError ?? '');
      }
      state = state.copyWith(needPermission: result.needPermission);
      if (result.status case final status?) state = state.copyWith(status: status, loaded: true);
    } else {
      await _channel.stop();
      state = state.copyWith(needPermission: const []);
    }
    await _load(_channel);
  });

  Future<void> scan() => _run(() async {
    state = state.copyWith(scanning: true);
    final devices = await _channel.scan();
    state = state.copyWith(devices: devices);
  });

  Future<void> connect(String address) => _run(() async {
    await _channel.connect(address);
    await _load(_channel);
  });

  Future<void> disconnect() => _run(() async {
    await _channel.disconnect();
    await _load(_channel);
  });

  /// Writes one or more stored fields; true when the native side kept them.
  Future<bool> configure({String? bridgeUrl, bool? autoConnect, String? devicePrefix}) async {
    var saved = false;
    await _run(() async {
      await _channel.configure(bridgeUrl: bridgeUrl, autoConnect: autoConnect, devicePrefix: devicePrefix);
      ref.invalidate(embodiedConfigProvider);
      saved = true;
    });
    return saved;
  }

  Future<void> openSystemBluetooth() => _run(_channel.openSystemBluetooth);
}

final embodiedProvider = NotifierProvider<EmbodiedController, EmbodiedUiState>(EmbodiedController.new);
