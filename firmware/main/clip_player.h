// clip_player.h —— 播 pet2clip 生成的 PCLP 容器（桌宠帧动画）。
//
// 一个 mood 一个 clip：idle / look(东张西望) / happy(开心跃动) / wave(元气挥手) / tickle(挠痒笑)。
// 数据全部编译期嵌进固件（main/CMakeLists.txt 的 target_add_binary_data），
// 不走分区表 —— 刷机只写 app 槽，ota_0 的旧固件留着当退路。
//
// 格式见 tools/pet2clip.py 头注释。这里只负责"第 n 帧的 4bpp 索引 → RGB565"。
#pragma once

#include <cstdint>

namespace clip_player {

// 交互/闲置也进这张表：Shy=被摸、Angry=被逗烦、Dangle=被拿起、Roam=自己溜达
enum Id : int { kIdle = 0, kLook, kHappy, kWave, kTickle, kShy, kAngry, kDangle, kRoam, kCount };

bool Init();      // 解析全部内嵌 clip（缺哪个就跳过哪个）
bool Ready(Id id);
int Loaded();     // 成功加载了几个

int Width(Id id);
int Height(Id id);
int Fps(Id id);
int Frames(Id id);

// 16 项 RGB565（主机序，未换字节）；render 自己 be() 后传给 Next()。
const uint16_t* Palette(Id id);

// 顺序推进一帧（到末尾自动回 0）并展开到 fb。pal_be 是已换好面板字节序的调色板。
// 返回帧号；未就绪返回 -1。
int Next(Id id, uint16_t* fb, int stride, int x, int y, const uint16_t* pal_be);

void Rewind(Id id);
int Current(Id id);

}  // namespace clip_player
