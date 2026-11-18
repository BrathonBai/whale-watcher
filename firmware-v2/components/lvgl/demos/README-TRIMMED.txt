# lvgl/demos 已被裁掉（发布包瘦身）

LVGL 的 CMakeLists 会无条件把 `demos` 当 include 目录，所以这个目录**必须存在**，
但内容可以没有：本工程的 `sdkconfig` 里所有 `CONFIG_LV_USE_DEMO_*` 都是关闭的，不会编译任何 demo。

被删掉的是 57 MB 的 demo 资源（`lv_demo_music` 的封面图等）。要恢复：

```
git clone --depth 1 -b v9.2.2 https://github.com/lvgl/lvgl.git tmp
robocopy tmp\demos components\lvgl\demos /E
```

（版本以 `components/lvgl/lv_version.h` 里的 `LVGL_VERSION_*` 为准。）
