// 状态指示灯：颜色 = 状态，一眼能看出设备在干什么
#pragma once
namespace led {
enum Mode { kOff, kIdle, kListen, kThink, kSpeak, kError };
void Init();
void Set(Mode m);
}