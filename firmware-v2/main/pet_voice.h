// pet_voice.h —— 摸摸头的本地短音效（内嵌 PCM，24 kHz/mono/s16le）
//
// 为什么不用 TTS：互动反馈要"立刻响"，走网络 TTS 至少几百毫秒且会占用对话音频链路；
// 内嵌 0.4–0.8 秒的短音效最稳（总 ~140 KB flash）。
// 播放放在一次性任务里（audio::Play 是实时阻塞写），不阻塞 UI/动画。
#pragma once

namespace pet_voice {

// 按互动动作挑一句（clip_player::Id 的整数值）：
//   happy→嘿嘿/最喜欢啦  tickle→唔，痒  shy→再摸摸  wave→好舒服
void PlayForClip(int clip_id);

bool Busy();

}  // namespace pet_voice
