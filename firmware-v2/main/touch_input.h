// touch_input.h —— SenseCAP Watcher 的 412×412 圆屏触摸（SPD2010，I2C1）
//
// 2026-11-04：v2 之前只初始化了显示面板，触摸控制器从没被点过；
// 这里按 BSP 的硬件参数接上：I2C1 / SDA39 / SCL38 / 400 kHz / 地址 0x53，
// 不复位（LCD reset 共用）、不用中断（INT 在 PCA9535 P0.5，直接轮询）。
//
// 手势在这里只做"识别"，具体动作（摸摸头/音量/菜单）由 app_ui 注册回调决定；
// 回调在触摸任务上下文执行，app_ui 只置事件标志，由 UI 任务统一处理（避免跨任务改 UI 状态）。
#pragma once

namespace touch_input {

using Cb = void (*)();

bool Init();

// 注册手势回调（在 Init 前调用；空回调安全）
// 单击/双击带坐标（屏幕像素，0..411），方便按区域分派（角色/字幕/顶部）。
void OnTap(void (*cb)(int x, int y));
void OnDouble(void (*cb)(int x, int y));
void OnLong(Cb cb);                       // 长按（≥700ms 不动）：菜单
void OnSwipe(void (*cb)(int dx, int dy)); // 滑动：dx/dy 为像素位移（右/下为正）

bool Ready();
int LastX();
int LastY();

}  // namespace touch_input
