idf_component_register(SRCS "esp_lcd_touch_chsc6x.c" INCLUDE_DIRS "include" REQUIRES "esp_lcd")
idf_component_get_property(_dep_espressif__esp_lcd_touch espressif__esp_lcd_touch COMPONENT_LIB)
target_link_libraries(${COMPONENT_LIB} PUBLIC ${_dep_espressif__esp_lcd_touch})
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-incompatible-pointer-types)
