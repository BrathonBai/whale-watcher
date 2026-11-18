// hub v2：BSP 提供电源/总线/RGB/电量/音频，我们自己管面板、动画、输入
#include "esp_log.h"
#include "esp_system.h"
#include "esp_idf_version.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_ops.h"
#include "sensecap-watcher.h"
#include "board_watcher.h"
#include "render.h"
#include "clip_player.h"
#include "input.h"
#include "audio.h"
#include "app_ui.h"
#include "camera.h"
#include "console.h"
#include "link.h"
#include "nvs_flash.h"
#include "storage.h"
#include "mp3_player.h"
#include "proto.h"
#include <cstring>

static const char* TAG = "v2";

/** 复位原因 → 人能读的中文（用于开机第一屏：区分"上电/软件重启/panic/WDT/brownout"）。 */
static const char* ResetReasonName(esp_reset_reason_t r) {
    switch (r) {
        case ESP_RST_POWERON: return "上电";
        case ESP_RST_EXT: return "外部引脚";
        case ESP_RST_SW: return "软件重启(esp_restart)";
        case ESP_RST_PANIC: return "异常(panic)";
        case ESP_RST_INT_WDT: return "中断看门狗";
        case ESP_RST_TASK_WDT: return "任务看门狗";
        case ESP_RST_WDT: return "其它看门狗";
        case ESP_RST_DEEPSLEEP: return "深睡唤醒";
        case ESP_RST_BROWNOUT: return "欠压(brownout)";
        case ESP_RST_SDIO: return "SDIO";
        case ESP_RST_USB: return "USB";
        case ESP_RST_JTAG: return "JTAG";
        case ESP_RST_EFUSE: return "eFuse 错误";
        case ESP_RST_PWR_GLITCH: return "电源毛刺";
        case ESP_RST_CPU_LOCKUP: return "CPU 死锁";
        default: return "未知";
    }
}

/** 内存观测：v2 自己的数字，不再拿 v1 日志推断（v1 已废弃）。 */
static void LogHeap(const char* stage) {
    ESP_LOGI(TAG, "[mem] %-10s 内部 free=%u largest=%u | PSRAM free=%u largest=%u", stage,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));
}

static void UiTask(void*) {
    // 2026-11-03：每 60 s 打一次 UI 任务栈水位（uxTaskGetStackHighWaterMark 在 IDF 里单位是字节）。
    // 目的：给"下一个 5 KB 栈"做决策——历史上内部 RAM 只剩 ~20 KB，先量真实水位再动任务栈。
    int64_t next_stack_log_us = esp_timer_get_time() + 60000000;
    for (;;) {
        render::Tick(esp_timer_get_time());
        // 2026-11-03：20ms → 10ms。桌宠按素材 fps（多为 10fps=100ms）播放，
        // 20ms tick 会把帧间隔量化成 100~120ms（实测 9fps，看起来一顿一顿）；
        // 10ms tick 的唤醒开销很小（Tick 不画帧时几下判断就返回）。
        vTaskDelay(pdMS_TO_TICKS(10));
        const int64_t now = esp_timer_get_time();
        if (now >= next_stack_log_us) {
            next_stack_log_us = now + 60000000;
            ESP_LOGI(TAG, "[ui] 栈水位 剩余 %u B | 内部 free=%u largest=%u",
                     (unsigned)uxTaskGetStackHighWaterMark(nullptr),
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                     (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
        }
    }
}

extern "C" void app_main(void) {
    // 2026-11-03：可观测性第一屏——先于任何初始化打出来，回答"这次到底跑的是哪个 bin、
    // 上次是怎么重启的"。复位原因能直接区分 上电 / esp_restart / panic / WDT / brownout。
    // 版本/协议号取 proto.h 的常量（与 hello 上报同一来源，避免两套版本漂移）；
    // Flash 容量用构建期配置 CONFIG_ESPTOOLPY_FLASHSIZE（本机 32MB，与设备实测一致）：
    // 本轮 main/CMakeLists.txt 禁改、spi_flash 头拿不到，所以没用 esp_flash_get_size()；
    // 下一轮给 main 的 REQUIRES 加 spi_flash 后可换成实测值（文档 §3.5）。
    const esp_reset_reason_t rst = esp_reset_reason();
    ESP_LOGI(TAG, "固件 %s %s（proto %d）  编译 %s %s  IDF %s", proto::kFwVersion,
             proto::kFwVerString, proto::kProtocolVersion, __DATE__, __TIME__,
             esp_get_idf_version());
    ESP_LOGI(TAG, "Flash 配置 %s  复位原因 %d（%s）", CONFIG_ESPTOOLPY_FLASHSIZE, (int)rst,
             ResetReasonName(rst));
    if (rst == ESP_RST_PANIC || rst == ESP_RST_TASK_WDT || rst == ESP_RST_INT_WDT ||
        rst == ESP_RST_WDT || rst == ESP_RST_CPU_LOCKUP || rst == ESP_RST_BROWNOUT) {
        ESP_LOGE(TAG, "上次复位是异常（%s）：若固件开了 coredump 且分区表已刷，"
                      "重启前可用 esptool 读 0x1a00000 取 core dump（见 docs/迭代-2026-11-03-固件配置与稳定性.md）",
                 ResetReasonName(rst));
    }

    // FW-11：2026-10-30 的教训是"根本没调 nvs_flash_init"；现在调了，但返回值不能吞——
    // 分区满/版本旧时 init 会失败，之后 BLE 绑定/设置读写全废，而日志看起来一切正常。
    esp_err_t nvs_err = nvs_flash_init();
    if (nvs_err == ESP_ERR_NVS_NO_FREE_PAGES || nvs_err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS 需要擦除（%s），擦除后重试", esp_err_to_name(nvs_err));
        nvs_flash_erase();
        nvs_err = nvs_flash_init();
    }
    if (nvs_err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_flash_init 失败：%s（BLE 绑定/设置读写会失败）", esp_err_to_name(nvs_err));
    }
    ESP_LOGI(TAG, "==== hub v2（BSP + 自绘 + 三段动画）====");
    LogHeap("boot");

    // 音频必须最先：bsp_codec_init() 内部会自己初始化 I2C/PA，
    // 我们抢先调 bsp_i2c_bus_init() 会让它内部那次失败 → ctrl_if NULL → assert。
    const bool audio_ok = audio::Init();   // 音频暂缓：esp_codec_dev 的 i2c_ctrl_if 建不起来（见 docs）
    ESP_LOGI(TAG, "扩展器: %p", (void*)bsp_io_expander_init());   // 必须先建，否则读键恒为 0
    ESP_LOGI(TAG, "i2c:%s spi:%s", esp_err_to_name(bsp_i2c_bus_init()),
             esp_err_to_name(bsp_spi_bus_init()));

    // TF 卡只服务 mp3（/sdcard/mp3）；桌宠 clip 已全部内嵌，不再依赖卡，
    // 也不再把卡上的 anim 抄进 PSRAM（2026-11-02 删掉 v1 时代的 SD 优先路径）。
    const bool sd_ok = storage::Init() == ESP_OK;
    if (!sd_ok) {
        ESP_LOGW(TAG, "没有 TF 卡：mp3 播放不可用（动画/对话不受影响）");
    }
    LogHeap("after-sd");

    esp_lcd_panel_handle_t panel = nullptr;
    if (watcher::LcdInit(&panel) == ESP_OK) {
        watcher::BacklightInit();
        if (!render::Init(panel)) ESP_LOGE(TAG, "render init 失败");
        clip_player::Init();
        ESP_LOGI(TAG, "clip 就绪 %d 段", clip_player::Loaded());
        render::SetMood(proto::Mood::Idle);
        LogHeap("after-ui");
    } else {
        ESP_LOGE(TAG, "面板起不来");
    }

    const bool cam_ok = camera::Init();   // 只初始化，不启动周期采样
    ESP_LOGW(TAG, "camera: %s（按需拍照；不做周期采集）", cam_ok ? "就绪" : "未就绪");
    input::Init();
    // 2026-11-13 真机教训（BLE 第一版）：audio_dec 任务栈、LED 的 RMT 通道、触摸都必须在
    // NimBLE 之前申请内部 RAM。实测 BLE 协议栈会吃掉约 60 KB 内部 RAM；之后再建解码任务/RMT
    // 通道就可能失败，BSP 的 ESP_ERROR_CHECK 直接 abort → 重启循环。
    // 所以先把 app_ui（音频流/解码任务/触摸/LED）和 UI 任务栈建好，再启动链路。
    app_ui::Init();
    console::Init();   // 串口行命令：>help / >link / >stat / >adpcm
    xTaskCreate(UiTask, "ui", 6144, nullptr, 4, nullptr);
    // 传输门面（2026-11-13 v0.4）：**只保留 BLE**。设备不再初始化 WiFi、不再连 PC 桥；
    // 手机 App 作为 BLE central，桥跑在手机 PRoot 引擎里。链路初始化放到最后，
    // 让它去申请内部 RAM 前 UI/解码/触摸/LED 已经就绪（见上面的真机内存教训）。
    link::Init();
    link::Start();
    LogHeap("after-app");

    (void)audio_ok;   // 音频由 app_ui 驱动
    if (!audio_ok) ESP_LOGE(TAG, "音频初始化失败：本次启动录音/播放不可用（UI 仍可操作）");

    // 渲染必须是**最低**的实时任务：412×412 满帧 9 fps 会长时间占 CPU/PSRAM，
    // 优先级高于音频/网络时会把 I2S 和 WS 接收一起饿死（2026-10-31 实测：下行只剩
    // ~20 KB/s、播放断音）。优先级顺序见 main/README 的"任务优先级"。
    // （UI 任务已在链路启动前创建，见上。）

    // 本地 MP3：必须在 app_ui::Init()（里面调 audio::StreamInit）之后，
    // 否则播放任务会走 StreamWrite 的退化分支（阻塞播）。
    // 2026-11-13 真机教训：没有 TF 卡时 mp3::Init 仍会在 **内部 RAM** 申请约 24 KB
    // （解码 PCM/单声道/输出缓冲 + 任务栈），把 BLE 运行期的内部堆压到 10 KB 级，
    // 导致拍照（SSCMA SPI 队列）失败。没有卡就不初始化播放器。
    if (sd_ok && mp3::Init()) {
        mp3::Autoplay();   // /sdcard/mp3 里有歌就自动放，没有就安静待着
    }

    for (;;) vTaskDelay(pdMS_TO_TICKS(5000));
}