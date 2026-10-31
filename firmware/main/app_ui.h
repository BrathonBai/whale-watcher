// v2 交互状态机：单击=录音开关 / 长按=菜单 / idle 旋钮=音量
//   IDLE --单击--> REC --单击/10s--> SEND --> IDLE（SEND 目前先回放自检，WS 接上后改成上行）
#pragma once
namespace app_ui { void Init(); }