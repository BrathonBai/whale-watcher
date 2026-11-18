import 'package:dsh_app/embodied/embodied_channel.dart';

/// The 鲸鲸蓝牙 gateway with no platform side: every call reports the missing
/// plugin at once, without a platform message round trip, so no test (or
/// golden) waits on a reply that a widget test can't deliver.
///
/// `test/flutter_test_config.dart` installs it for every test file; tests about
/// the channel or the page override the providers themselves.
class QuietEmbodiedChannel extends EmbodiedChannel {
  @override
  Future<bool> available() async => false;

  @override
  Future<EmbodiedStatus> status() => _missing();

  @override
  Future<EmbodiedStartResult> start() => _missing();

  @override
  Future<void> stop() => _missing();

  @override
  Future<List<EmbodiedDevice>> scan({int? timeoutMs}) => _missing();

  @override
  Future<void> connect(String address) => _missing();

  @override
  Future<void> disconnect() => _missing();

  @override
  Future<EmbodiedConfig> config() => _missing();

  @override
  Future<EmbodiedConfig> configure({String? bridgeUrl, bool? autoConnect, String? devicePrefix, bool? enabled}) =>
      _missing();

  @override
  Future<void> openSystemBluetooth() => _missing();

  Future<T> _missing<T>() => Future<T>.error(const EmbodiedException(EmbodiedErrorKind.missingPlugin));
}
