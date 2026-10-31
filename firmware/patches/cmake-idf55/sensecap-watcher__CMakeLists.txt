
set(requires "esp_mm" "esp_psram" "esp_lcd" "fatfs" "esp_timer" "driver" "spiffs" "sdmmc" "vfs")

idf_component_register(
    SRCS "sensecap-watcher.c"
    INCLUDE_DIRS "include"
    # PRIV_REQUIRES ${priv_requires}
    REQUIRES ${requires}
)
idf_component_get_property(_dep_esp_io_expander_pca95xx_16bit esp_io_expander_pca95xx_16bit COMPONENT_LIB)
target_link_libraries(${COMPONENT_LIB} PUBLIC ${_dep_esp_io_expander_pca95xx_16bit})
idf_component_get_property(_dep_espressif__esp_lcd_spd2010 espressif__esp_lcd_spd2010 COMPONENT_LIB)
target_link_libraries(${COMPONENT_LIB} PUBLIC ${_dep_espressif__esp_lcd_spd2010})
idf_component_get_property(_dep_knob knob COMPONENT_LIB)
target_link_libraries(${COMPONENT_LIB} PUBLIC ${_dep_knob})
idf_component_get_property(_dep_espressif__led_strip espressif__led_strip COMPONENT_LIB)
target_link_libraries(${COMPONENT_LIB} PUBLIC ${_dep_espressif__led_strip})
idf_component_get_property(_dep_espressif__button espressif__button COMPONENT_LIB)
target_link_libraries(${COMPONENT_LIB} PUBLIC ${_dep_espressif__button})
idf_component_get_property(_dep_espressif__esp_codec_dev espressif__esp_codec_dev COMPONENT_LIB)
target_link_libraries(${COMPONENT_LIB} PUBLIC ${_dep_espressif__esp_codec_dev})
idf_component_get_property(_dep_sscma_client sscma_client COMPONENT_LIB)
target_link_libraries(${COMPONENT_LIB} PUBLIC ${_dep_sscma_client})
idf_component_get_property(_dep_espressif__esp_io_expander espressif__esp_io_expander COMPONENT_LIB)
target_link_libraries(${COMPONENT_LIB} PUBLIC ${_dep_espressif__esp_io_expander})
idf_component_get_property(_dep_lvgl lvgl COMPONENT_LIB)
target_link_libraries(${COMPONENT_LIB} PUBLIC ${_dep_lvgl})
idf_component_get_property(_dep_esp_lvgl_port esp_lvgl_port COMPONENT_LIB)
target_link_libraries(${COMPONENT_LIB} PUBLIC ${_dep_esp_lvgl_port})
idf_component_get_property(_dep_espressif__esp_lcd_touch_spd2010 espressif__esp_lcd_touch_spd2010 COMPONENT_LIB)
target_link_libraries(${COMPONENT_LIB} PUBLIC ${_dep_espressif__esp_lcd_touch_spd2010})
