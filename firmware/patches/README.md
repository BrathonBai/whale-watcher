# patches/ —— 给第三方组件打的 IDF 5.5 兼容补丁

`cmake-idf55/` 里是 5 个**完整文件**（不是 diff），文件名格式 `<组件名>__CMakeLists.txt`，
对应覆盖到：

```
components/<组件名>/CMakeLists.txt
```

`install/fetch-deps.ps1` 复制完组件后会自动覆盖这 5 个文件。

## 为什么用"整文件覆盖"而不是 patch

上游组件的 CMakeLists 很短（10~40 行），而三次改动（组件改名、依赖显式声明、
移除 `package_manager`）会互相交叠；整文件覆盖最不容易在 `git apply` 上翻车，
也方便自己核对——直接和 `components/<组件名>/CMakeLists.txt` 对比即可。

## 自己核对

```powershell
# 差异一目了然
git diff --no-index components/knob/CMakeLists.txt patches/cmake-idf55/knob__CMakeLists.txt
```

## 这些补丁会被上游取代吗

会。等 Seeed 的仓库适配 IDF 5.5 后，删掉 `patches/` 与 `fetch-deps.ps1` 里的覆盖步骤即可。
在此之前不要删：**上游原版在 IDF 5.5 下直接 CMake 报错**（`package_manager` 找不到 /
`espressif__esp_lcd_touch` 解析失败）。
