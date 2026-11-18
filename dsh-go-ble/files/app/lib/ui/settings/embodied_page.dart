// 鲸鲸蓝牙: the BLE gateway between the phone and the SenseCAP Watcher.
//
// The page follows the settings family's structure (performance_page.dart):
// the hub row in this file, AppPage.list below it, SettingsSection cards in
// between. Text comes from embodied_strings.dart (v1 does not use the ARB
// chain); the icon is the app's existing robot glyph (AppIcons.bot is
// DshGlyphs.robot), so no icon font changes.
//
// Every operation shows its own feedback: a spinner while it runs, and either
// the native error or a brief confirmation — nothing is silent.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../embodied/embodied_channel.dart';
import '../../embodied/embodied_state.dart';
import '../../embodied/embodied_strings.dart';
import '../../l10n/l10n.dart';
import '../common/app_dialog.dart';
import '../common/brief_notice.dart';
import '../common/list_page_row.dart';
import '../phone/phone_widgets.dart' show PhoneNote, NoteTone;
import '../shell/page_frame.dart';
import '../theme/app_icons.dart';
import 'settings_widgets.dart';

/// The hub row that opens [EmbodiedPage]; its value says whether the link is on.
class EmbodiedSettingsTile extends ConsumerWidget {
  const EmbodiedSettingsTile({super.key, this.tint = 0});

  final int tint;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final strings = EmbodiedStrings.of(context);
    final state = ref.watch(embodiedProvider);
    final value = _hubValue(state, strings);
    return SettingsTile(
      key: const ValueKey('settings-embodied'),
      icon: AppIcons.bot,
      tint: tint,
      spot: SettingsIndex.entry(SettingsPageId.embodied),
      value: value == null ? null : Text(value),
      onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const EmbodiedPage())),
    );
  }

  static String? _hubValue(EmbodiedUiState state, EmbodiedStrings strings) {
    if (!state.loaded) return null;
    if (state.unsupported) return strings.unavailable;
    return state.enabled ? strings.on : strings.off;
  }
}

class EmbodiedPage extends ConsumerWidget {
  const EmbodiedPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final strings = EmbodiedStrings.of(context);
    final state = ref.watch(embodiedProvider);
    final config = ref.watch(embodiedConfigProvider);
    final controller = ref.read(embodiedProvider.notifier);
    final status = state.status;
    final permissionHint = strings.permissionHint(state.needPermission);
    final error = state.error;
    final connectedAddress = status?.ble.device?.address;
    return AppPage.list(
      title: strings.pageTitle,
      subtitle: state.unsupported ? Text(strings.unsupportedHint) : null,
      children: [
        SettingsSection(
          title: strings.sectionStatus,
          children: [
            InfoRow(
              label: strings.labelService,
              value: status == null ? strings.loading : strings.service(status.service),
            ),
            InfoRow(
              label: strings.labelBluetooth,
              value: status == null ? strings.loading : strings.adapter(status.adapter),
            ),
            InfoRow(
              label: strings.labelPermission,
              value: status == null ? strings.loading : strings.permission(status.permission),
            ),
            InfoRow(
              label: strings.labelEngine,
              value: status == null ? strings.loading : strings.engine(status.engine),
            ),
            InfoRow(
              label: strings.labelDevice,
              value: status == null ? strings.loading : strings.deviceLine(status.ble),
            ),
            InfoRow(
              label: strings.labelBridge,
              value: status == null ? strings.loading : strings.bridgeLine(status.bridge),
            ),
            if (status != null && status.lastError.isNotEmpty)
              InfoRow(label: strings.labelLastError, value: status.lastError, mono: true),
          ],
        ),
        if (error != null)
          PhoneNote(text: strings.errorText(error), tone: NoteTone.danger, margin: kSettingsGroupMargin),
        SettingsSection(
          title: strings.sectionLink,
          footer: permissionHint.isEmpty ? null : Text(permissionHint),
          children: [
            SettingsSwitchTile(
              key: const ValueKey('embodied-enable'),
              spot: Spots.embodiedEnable,
              subtitle: strings.enableSubtitle,
              value: state.enabled,
              onChanged: state.busy ? null : (bool enabled) => unawaited(controller.setEnabled(enabled)),
            ),
          ],
        ),
        SettingsSection(
          title: strings.sectionDevices,
          footer: state.devices.isEmpty ? Text(state.scanning ? strings.scanning : strings.noDevicesYet) : null,
          children: [
            SettingsTile(
              key: const ValueKey('embodied-scan'),
              spot: Spots.embodiedScan,
              icon: AppIcons.search,
              tinted: false,
              subtitle: state.scanning ? strings.scanning : strings.scanHint,
              trailing: state.scanning
                  ? const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2))
                  : null,
              onTap: state.busy ? null : () => unawaited(controller.scan()),
            ),
            SettingsTile(
              key: const ValueKey('embodied-connection'),
              spot: Spots.embodiedConnection,
              icon: AppIcons.link,
              tinted: false,
              subtitle: state.connected ? strings.disconnectHint : strings.connectHint,
              value: Text(status == null ? strings.loading : strings.bleState(status.ble.state)),
              onTap: state.busy
                  ? null
                  : () => unawaited(state.connected ? controller.disconnect() : controller.scan()),
            ),
            for (final device in state.devices)
              ListPageRow(
                key: ValueKey('embodied-device-${device.address}'),
                icon: AppIcons.thisPhone,
                title: device.name.isEmpty ? device.address : device.name,
                subtitle: device.address,
                meta: strings.formatRssi(device.rssi),
                trailing: device.address == connectedAddress
                    ? Icon(AppIcons.radioOn, size: 20, color: Theme.of(context).colorScheme.primary)
                    : null,
                onTap: state.busy ? null : () => unawaited(controller.connect(device.address)),
              ),
          ],
        ),
        SettingsSection(
          title: strings.sectionAdvanced,
          children: [
            SettingsSwitchTile(
              key: const ValueKey('embodied-auto-connect'),
              spot: Spots.embodiedAutoConnect,
              subtitle: strings.autoConnectSubtitle,
              value: config.value?.autoConnect ?? true,
              onChanged: state.busy ? null : (bool value) => unawaited(_saveAutoConnect(context, ref, value)),
            ),
            SettingsTile(
              key: const ValueKey('embodied-bridge-url'),
              spot: Spots.embodiedBridgeUrl,
              icon: AppIcons.link,
              tinted: false,
              subtitle: config.value?.bridgeUrl ?? EmbodiedConfig.defaultBridgeUrl,
              onTap: state.busy ? null : () => unawaited(_editBridgeUrl(context, ref)),
            ),
            SettingsTile(
              key: const ValueKey('embodied-device-prefix'),
              spot: Spots.embodiedDevicePrefix,
              icon: AppIcons.rename,
              tinted: false,
              value: Text(config.value?.devicePrefix ?? EmbodiedConfig.defaultDevicePrefix),
              subtitle: strings.devicePrefixSubtitle,
              onTap: state.busy ? null : () => unawaited(_editDevicePrefix(context, ref)),
            ),
          ],
        ),
        SettingsSection(
          title: strings.sectionDiagnostics,
          footer: state.logs.isEmpty ? null : Text(state.logs.last),
          children: [
            InfoRow(
              label: strings.labelTxBytes,
              value: status == null ? '—' : strings.formatBytes(status.ble.txBytes),
            ),
            InfoRow(
              label: strings.labelRxBytes,
              value: status == null ? '—' : strings.formatBytes(status.ble.rxBytes),
            ),
            InfoRow(label: strings.labelTxDrop, value: status == null ? '—' : '${status.ble.txDrop}'),
            InfoRow(label: strings.labelRxDrop, value: status == null ? '—' : '${status.ble.rxDrop}'),
            InfoRow(label: strings.labelReconnects, value: status == null ? '—' : '${status.bridge.reconnects}'),
            SettingsTile(
              key: const ValueKey('embodied-refresh'),
              spot: Spots.embodiedRefresh,
              icon: AppIcons.refresh,
              tinted: false,
              onTap: state.busy ? null : () => unawaited(controller.refresh()),
            ),
            SettingsTile(
              key: const ValueKey('embodied-open-bluetooth'),
              spot: Spots.embodiedOpenBluetooth,
              icon: AppIcons.openExternal,
              tinted: false,
              onTap: state.busy ? null : () => unawaited(controller.openSystemBluetooth()),
            ),
          ],
        ),
        // 大字号下最后一行也要能整个滚进视野.
        const SizedBox(height: 72),
      ],
    );
  }
}

Future<void> _saveAutoConnect(BuildContext context, WidgetRef ref, bool value) async {
  final ok = await ref.read(embodiedProvider.notifier).configure(autoConnect: value);
  if (!context.mounted) return;
  _notify(context, ref, ok: ok);
}

Future<void> _editBridgeUrl(BuildContext context, WidgetRef ref) async {
  final l10n = context.l10n;
  final strings = EmbodiedStrings.of(context);
  var input = ref.read(embodiedConfigProvider).value?.bridgeUrl ?? EmbodiedConfig.defaultBridgeUrl;
  final value = await showAppDialog<String>(
    context: context,
    builder: (dialog) => AlertDialog(
      title: Text(strings.titleBridgeUrl),
      content: TextFormField(
        initialValue: input,
        onChanged: (next) => input = next,
        autofocus: true,
        keyboardType: TextInputType.url,
        decoration: InputDecoration(hintText: strings.bridgeUrlHint),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialog), child: Text(l10n.commonCancel)),
        FilledButton(onPressed: () => Navigator.pop(dialog, input.trim()), child: Text(l10n.commonSave)),
      ],
    ),
  );
  if (value == null || value.isEmpty) return;
  if (!EmbodiedConfig.isValidBridgeUrl(value)) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showBriefNotice(strings.invalidBridgeUrl);
    return;
  }
  final ok = await ref.read(embodiedProvider.notifier).configure(bridgeUrl: value);
  if (!context.mounted) return;
  _notify(context, ref, ok: ok);
}

Future<void> _editDevicePrefix(BuildContext context, WidgetRef ref) async {
  final l10n = context.l10n;
  final strings = EmbodiedStrings.of(context);
  var input = ref.read(embodiedConfigProvider).value?.devicePrefix ?? EmbodiedConfig.defaultDevicePrefix;
  final value = await showAppDialog<String>(
    context: context,
    builder: (dialog) => AlertDialog(
      title: Text(strings.titleDevicePrefix),
      content: TextFormField(
        initialValue: input,
        onChanged: (next) => input = next,
        autofocus: true,
        decoration: InputDecoration(hintText: strings.devicePrefixHint),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialog), child: Text(l10n.commonCancel)),
        FilledButton(onPressed: () => Navigator.pop(dialog, input.trim()), child: Text(l10n.commonSave)),
      ],
    ),
  );
  if (value == null) return;
  if (value.isEmpty) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showBriefNotice(strings.invalidDevicePrefix);
    return;
  }
  final ok = await ref.read(embodiedProvider.notifier).configure(devicePrefix: value);
  if (!context.mounted) return;
  _notify(context, ref, ok: ok);
}

/// 已保存, or the error the operation left behind: never a silent failure.
void _notify(BuildContext context, WidgetRef ref, {required bool ok}) {
  if (!context.mounted) return;
  final l10n = context.l10n;
  final strings = EmbodiedStrings.of(context);
  final error = ref.read(embodiedProvider).error;
  ScaffoldMessenger.of(context).showBriefNotice(
    ok ? l10n.commonSaved : strings.errorText(error ?? const EmbodiedException(EmbodiedErrorKind.platform)),
  );
}
