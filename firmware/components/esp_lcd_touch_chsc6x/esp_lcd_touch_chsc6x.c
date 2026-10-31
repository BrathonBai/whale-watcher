/*
 * SPDX-FileCopyrightText: Seeed Tech. Co., Ltd.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/i2c.h"
#include "esp_check.h"
#include "esp_err.h"
#include "esp_lcd_touch.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define CHSC6X_READ_POINT_LEN (5)

static const char *TAG = "CHSC6X";

/*******************************************************************************
 * Function definitions
 *******************************************************************************/
static esp_err_t esp_lcd_touch_chsc6x_read_data(esp_lcd_touch_handle_t tp);
static bool esp_lcd_touch_chsc6x_get_xy(esp_lcd_touch_handle_t tp, uint16_t *x, uint16_t *y, uint16_t *strength, uint8_t *point_num, uint8_t max_point_num);

static esp_err_t esp_lcd_touch_chsc6x_del(esp_lcd_touch_handle_t tp);

/* I2C read */
static esp_err_t touch_chsc6x_i2c_read(esp_lcd_touch_handle_t tp, uint8_t *data, uint8_t len);

/* CHSC6X reset */
static esp_err_t touch_chsc6x_reset(esp_lcd_touch_handle_t tp);

/* CHSC6X write */
static esp_err_t touch_chsc6x_i2c_write(esp_lcd_touch_handle_t tp, uint16_t reg, uint8_t *data, uint16_t len);

/*******************************************************************************
 * Public API functions
 *******************************************************************************/

esp_err_t esp_lcd_touch_new_i2c_chsc6x(const esp_lcd_panel_io_handle_t io, const esp_lcd_touch_config_t *config, esp_lcd_touch_handle_t *out_touch)
{
    esp_err_t ret = ESP_OK;

    assert(config != NULL);
    assert(out_touch != NULL);

    /* Prepare main structure */
    esp_lcd_touch_handle_t esp_lcd_touch_chsc6x = heap_caps_calloc(1, sizeof(esp_lcd_touch_t), MALLOC_CAP_DEFAULT);
    ESP_GOTO_ON_FALSE(esp_lcd_touch_chsc6x, ESP_ERR_NO_MEM, err, TAG, "no mem for CHSC6X controller");

    /* Communication interface */
    esp_lcd_touch_chsc6x->io = io;

    /* Only supported callbacks are set */
    esp_lcd_touch_chsc6x->read_data = esp_lcd_touch_chsc6x_read_data;
    esp_lcd_touch_chsc6x->get_xy = esp_lcd_touch_chsc6x_get_xy;
    esp_lcd_touch_chsc6x->del = esp_lcd_touch_chsc6x_del;

    /* Mutex */
    esp_lcd_touch_chsc6x->data.lock.owner = portMUX_FREE_VAL;

    /* Save config */
    memcpy(&esp_lcd_touch_chsc6x->config, config, sizeof(esp_lcd_touch_config_t));

    /* Prepare pin for touch interrupt */
    if (esp_lcd_touch_chsc6x->config.int_gpio_num != GPIO_NUM_NC)
    {
        const gpio_config_t int_gpio_config = { .mode = GPIO_MODE_INPUT,
            .intr_type = (esp_lcd_touch_chsc6x->config.levels.interrupt ? GPIO_INTR_POSEDGE : GPIO_INTR_NEGEDGE),
            .pin_bit_mask = BIT64(esp_lcd_touch_chsc6x->config.int_gpio_num) };
        ret = gpio_config(&int_gpio_config);
        ESP_GOTO_ON_ERROR(ret, err, TAG, "GPIO config failed");

        /* Register interrupt callback */
        if (esp_lcd_touch_chsc6x->config.interrupt_callback)
        {
            esp_lcd_touch_register_interrupt_callback(esp_lcd_touch_chsc6x, esp_lcd_touch_chsc6x->config.interrupt_callback);
        }
    }

    /* Prepare pin for touch controller reset */
    if (esp_lcd_touch_chsc6x->config.rst_gpio_num != GPIO_NUM_NC)
    {
        const gpio_config_t rst_gpio_config = { .mode = GPIO_MODE_OUTPUT, .pin_bit_mask = BIT64(esp_lcd_touch_chsc6x->config.rst_gpio_num) };
        ret = gpio_config(&rst_gpio_config);
        ESP_GOTO_ON_ERROR(ret, err, TAG, "GPIO config failed");
    }

    /* Reset controller */
    ret = touch_chsc6x_reset(esp_lcd_touch_chsc6x);
    ESP_GOTO_ON_ERROR(ret, err, TAG, "CHSC6X reset failed");

    /* Initial read */
    ret = esp_lcd_touch_chsc6x_read_data(esp_lcd_touch_chsc6x);
    ESP_GOTO_ON_ERROR(ret, err, TAG, "CHSC6X init failed");

err:
    if (ret != ESP_OK)
    {
        ESP_LOGE(TAG, "Error (0x%x)! Touch controller CHSC6X initialization failed!", ret);
        if (esp_lcd_touch_chsc6x)
        {
            esp_lcd_touch_chsc6x_del(esp_lcd_touch_chsc6x);
        }
    }

    *out_touch = esp_lcd_touch_chsc6x;

    return ret;
}

static esp_err_t esp_lcd_touch_chsc6x_read_data(esp_lcd_touch_handle_t tp)
{
    esp_err_t err = ESP_OK;
    static uint8_t data[CHSC6X_READ_POINT_LEN];

    assert(tp != NULL);

    tp->data.points = 0;
    if (tp->config.int_gpio_num != GPIO_NUM_NC)
    {
        if (gpio_get_level(tp->config.int_gpio_num) != 0)
        {
            return ESP_OK;
        }
    }
    else if ((*(uint16_t *)tp->config.user_data) & (1 << 5))
    {
        return ESP_OK;
    }

    /* Get report data length */
    err = i2c_master_read_from_device(1, 0x2E, &data, sizeof(data), 20 / portTICK_PERIOD_MS);
    ESP_RETURN_ON_ERROR(err, TAG, "I2C read error %d!", err);
    /* Save data */
    portENTER_CRITICAL(&tp->data.lock);
    if (data[0] == 0x01 && data[2] <= 240 && data[4] <= 240)
    {
        tp->data.points = 1;
        tp->data.coords[0].x = data[2];
        tp->data.coords[0].y = data[4];
    }
    portEXIT_CRITICAL(&tp->data.lock);

    return ESP_OK;
}

static bool esp_lcd_touch_chsc6x_get_xy(esp_lcd_touch_handle_t tp, uint16_t *x, uint16_t *y, uint16_t *strength, uint8_t *point_num, uint8_t max_point_num)
{
    assert(tp != NULL);
    assert(x != NULL);
    assert(y != NULL);
    assert(point_num != NULL);
    assert(max_point_num > 0);

    portENTER_CRITICAL(&tp->data.lock);

    /* Count of points */
    *point_num = (tp->data.points > max_point_num ? max_point_num : tp->data.points);

    for (size_t i = 0; i < *point_num; i++)
    {
        x[i] = tp->data.coords[i].x;
        y[i] = tp->data.coords[i].y;

        if (strength)
        {
            strength[i] = tp->data.coords[i].strength;
        }
    }
    /* Invalidate */
    tp->data.points = 0;

    portEXIT_CRITICAL(&tp->data.lock);

    return (*point_num > 0);
}

static esp_err_t esp_lcd_touch_chsc6x_del(esp_lcd_touch_handle_t tp)
{
    assert(tp != NULL);

    /* Reset GPIO pin settings */
    if (tp->config.int_gpio_num != GPIO_NUM_NC)
    {
        gpio_reset_pin(tp->config.int_gpio_num);
        if (tp->config.interrupt_callback)
        {
            gpio_isr_handler_remove(tp->config.int_gpio_num);
        }
    }

    /* Reset GPIO pin settings */
    if (tp->config.rst_gpio_num != GPIO_NUM_NC)
    {
        gpio_reset_pin(tp->config.rst_gpio_num);
    }

    free(tp);

    return ESP_OK;
}

/*******************************************************************************
 * Private API function
 *******************************************************************************/

/* Reset controller */
static esp_err_t touch_chsc6x_reset(esp_lcd_touch_handle_t tp)
{
    assert(tp != NULL);

    if (tp->config.rst_gpio_num != GPIO_NUM_NC)
    {
        ESP_RETURN_ON_ERROR(gpio_set_level(tp->config.rst_gpio_num, tp->config.levels.reset), TAG, "GPIO set level error!");
        vTaskDelay(pdMS_TO_TICKS(10));
        ESP_RETURN_ON_ERROR(gpio_set_level(tp->config.rst_gpio_num, !tp->config.levels.reset), TAG, "GPIO set level error!");
        vTaskDelay(pdMS_TO_TICKS(10));
    }

    return ESP_OK;
}

static esp_err_t touch_chsc6x_i2c_read(esp_lcd_touch_handle_t tp, uint8_t *data, uint8_t len)
{
    assert(tp != NULL);
    assert(data != NULL);

    /* Read data */
    return esp_lcd_panel_io_rx_param(tp->io, -1, data, len);
}

static esp_err_t touch_chsc6x_i2c_write(esp_lcd_touch_handle_t tp, uint16_t reg, uint8_t *data, uint16_t len)
{
    assert(tp != NULL);
    assert(data != NULL);

    return esp_lcd_panel_io_tx_param(tp->io, reg, data, len);
}