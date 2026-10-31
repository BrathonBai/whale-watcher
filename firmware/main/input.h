// v2 输入：旋钮（A41/B42 裸 GPIO 正交解码）+ 按键（PCA9535 P1.3，走 BSP）
// 刻意不引入 LVGL 的 indev，也不调用 bsp_knob_btn_init —— 旋钮只有这一个所有者。
#pragma once

namespace input {

void Init();

// 累计格数（右转为正）
int Turns();

// 按键当前是否按下
bool KeyDown();

// 旋钮事件回调（一格的增量），可为空
void OnTurn(void (*cb)(int));

// 按键按下回调（去抖后，每按一次调一次），可为空
void OnPress(void (*cb)());
// 长按（≥1s，松手时触发）
void OnLongPress(void (*cb)());

}  // namespace input