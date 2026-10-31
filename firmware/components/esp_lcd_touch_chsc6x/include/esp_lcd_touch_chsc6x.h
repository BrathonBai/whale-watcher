/*
 * SPDX-FileCopyrightText: 2024 Seeed Tech. Co., Ltd.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file
 * @brief ESP LCD touch: CHSC6X
 */

#pragma once

#include "esp_lcd_touch.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Create a new CHSC6X touch driver
 *
 * @note The I2C communication should be initialized before use this function.
 *
 * @param io LCD/Touch panel IO handle
 * @param config: Touch configuration
 * @param out_touch: Touch instance handle
 * @return
 *      - ESP_OK                    on success
 *      - ESP_ERR_NO_MEM            if there is no memory for allocating main structure
 */
esp_err_t esp_lcd_touch_new_i2c_chsc6x(const esp_lcd_panel_io_handle_t io, const esp_lcd_touch_config_t *config, esp_lcd_touch_handle_t *out_touch);

/**
 * @brief I2C address of the CHSC6X controller
 *
 */
#define ESP_LCD_TOUCH_IO_I2C_CHSC6X_ADDRESS (0x2E)

/**
 * @brief Touch IO configuration structure
 *
 */
#define ESP_LCD_TOUCH_IO_I2C_CHSC6X_CONFIG()                                                                                                                                                           \
    {                                                                                                                                                                                                  \
        .dev_addr = ESP_LCD_TOUCH_IO_I2C_CHSC6X_ADDRESS, .control_phase_bytes = 1, .dc_bit_offset = 0, .lcd_cmd_bits = 8, .flags = {                                                                   \
            .disable_control_phase = 1,                                                                                                                                                                \
        }                                                                                                                                                                                              \
    }

#ifdef __cplusplus
}
#endif
