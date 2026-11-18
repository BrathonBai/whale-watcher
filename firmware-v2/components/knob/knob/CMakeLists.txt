idf_component_register(SRCS "iot_knob.c" 
                       INCLUDE_DIRS "."
                       REQUIRES driver
                       PRIV_REQUIRES esp_timer)

# include(package_manager)
# cu_pkg_define_version 被禁用后，版本宏得自己给
target_compile_definitions(${COMPONENT_LIB} PRIVATE KNOB_VER_MAJOR=1 KNOB_VER_MINOR=0 KNOB_VER_PATCH=0)
