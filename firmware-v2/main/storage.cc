// storage.cc —— TF 卡挂载（/sdcard）。**可选功能**：卡不在/挂载失败都不能让整机启动失败。
//
// 2026-11-03 修复（刷机后实测）：BSP 的 bsp_sdcard_init() 内部是
//   ESP_ERROR_CHECK(esp_vfs_fat_sdspi_mount(...))
// 没有卡时 sdmmc_init_sd_if_cond 返回 0x108 → ESP_ERROR_CHECK abort → 启动循环。
// 这里改成自己调 esp_vfs_fat_sdspi_mount（返回 esp_err_t），失败只 warn；
// 并且先看 DET 引脚，没插卡直接跳过（省掉 300ms 上电复位和一次必然失败的挂载）。
//
// 卡只服务 mp3（/sdcard/mp3）。桌宠 clip 已全部内嵌，WiFi/语音/拍照都不依赖卡。
#include "storage.h"

#include <cstdint>

#include "driver/sdspi_host.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_vfs_fat.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdmmc_cmd.h"
#include "sensecap-watcher.h"

namespace storage {
namespace {

constexpr const char* TAG = "sd";
constexpr const char* kMountPoint = "/sdcard";
constexpr int kMaxFiles = 8;

// 0 = 还没试，1 = 成功，-1 = 失败（不重试）
int s_state = 0;
sdmmc_card_t* s_card = nullptr;

}  // namespace

esp_err_t Init() {
    if (s_state == 1) return ESP_OK;
    if (s_state == -1) return ESP_ERR_INVALID_STATE;

    // 先问 DET 引脚：没插卡就别上电/挂载。DET 偶尔不可靠，所以只有明确"没插"才跳过。
    if (!bsp_sdcard_is_inserted()) {
        s_state = -1;
        ESP_LOGW(TAG, "没有 TF 卡：跳过挂载（mp3 不可用；动画/对话/拍照不受影响）");
        return ESP_ERR_NOT_FOUND;
    }

    // PCA9535 的输出在 ESP 复位后不会清零：热插卡 + 软复位时 TF 卡的电
    // 从头到尾没断过，卡可能停在未定义状态（现象：CMD8/CMD2 回 0x108）。
    // 这里把 PWR_SDCARD 拉低 300 ms 再拉高，等价于拔插一次。
    bsp_exp_io_set_level(BSP_PWR_SDCARD, 0);
    vTaskDelay(pdMS_TO_TICKS(300));
    bsp_exp_io_set_level(BSP_PWR_SDCARD, 1);
    vTaskDelay(pdMS_TO_TICKS(150));

    ESP_LOGI(TAG, "挂载前 内部堆 %u / 最大块 %u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));

    // 不走 bsp_sdcard_init_default()：它内部用 ESP_ERROR_CHECK，失败会 abort。
    // SPI 总线与 IO 扩展器已由 app_main 在调用本函数前初始化。
    sdmmc_host_t host = SDSPI_HOST_DEFAULT();
    // BSP_SD_SPI_NUM 是 BSP 头里的整数宏（spi2），sdmmc_host_t.slot 在 IDF 5.5 是
    // spi_host_device_t 枚举，显式转换避免 -fpermissive 报错。
    host.slot = (spi_host_device_t)BSP_SD_SPI_NUM;
    sdspi_device_config_t slot_config = SDSPI_DEVICE_CONFIG_DEFAULT();
    slot_config.gpio_cs = BSP_SD_SPI_CS;
    slot_config.host_id = (spi_host_device_t)BSP_SD_SPI_NUM;
    esp_vfs_fat_mount_config_t mount_config = {
        .format_if_mount_failed = false,
        .max_files = kMaxFiles,
        .allocation_unit_size = 16 * 1024,
    };
    const esp_err_t e =
        esp_vfs_fat_sdspi_mount(kMountPoint, &host, &slot_config, &mount_config, &s_card);
    if (e != ESP_OK) {
        s_state = -1;
        s_card = nullptr;
        // 0x108 多半是卡没插好/接触不良；不是致命错误。
        ESP_LOGW(TAG, "SD 挂载失败：%s（mp3 不可用，其余功能不受影响）", esp_err_to_name(e));
        return e;
    }

    s_state = 1;
    ESP_LOGI(TAG, "SD: 挂载成功（%s，卡 %llu MB）", kMountPoint,
             (unsigned long long)((uint64_t)s_card->csd.capacity / 1024 / 2));
    return ESP_OK;
}

bool Ready() { return s_state == 1; }

}  // namespace storage
