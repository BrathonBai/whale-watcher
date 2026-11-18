// mp3_player.h —— 从 TF 卡播放 MP3（minimp3 解码 → 24 kHz 单声道 → 现有环形缓冲）。
//
// 为什么不用 WiFi 推 PCM：这条链路实测 21–28 KB/s，而 24 kHz/16 bit PCM 要 48 KB/s。
// 本地文件把「声音」和「网络」彻底解耦，2.4 GHz 再堵也只影响字幕。
#pragma once

namespace mp3 {

// 申请缓冲 + 起播放任务；不碰网络。返回 false 只表示内存不够。
bool Init();

// 播放一个绝对路径（如 "/sdcard/mp3/BGM01.MP3"）。loop=true 时单曲循环。
// 立即返回；正在放别的会先停下再换。
bool Play(const char* path, bool loop);

// 停止当前播放（含自动播放）。
void Stop();

// 让路：TTS / 录音开始时调用。清空已排队的音乐采样，暂停供给。
void Pause();

// 恢复：等环形缓冲里 TTS 的尾巴播完（或本来就空）再续上。
void Resume();

bool IsPlaying();

// 开机自动播放：优先 /sdcard/mp3/PLAYLIST.TXT，否则扫目录里的 *.MP3，循环。
// 没有任何文件就安静地什么都不做。
void Autoplay();

}  // namespace mp3
