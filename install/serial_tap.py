#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""serial_tap.py —— 串口观察 + 单向输入（不重开端口，避免 DTR/RTS 反复复位设备）。

为什么要这个：CH342 的 DTR/RTS 接在 ESP32 的 EN/IO0 上，每次开串口都会复位芯片。
用 `idf.py monitor` 又不适合在非交互环境里跑。所以：**一次打开、长时间读**，
需要发命令时把一行文本写进 `--cmd-file`，本脚本轮询到就发出去并删掉该文件。

用法：
    python tools/serial_tap.py --port COM6 --seconds 60 --out logs/serial.log
    # 另一个窗口发命令（不碰串口）：
    echo ">status" > logs/serial_cmd.txt

    # 只看不存
    python tools/serial_tap.py --port COM6 --seconds 10
"""
import argparse
import os
import sys
import time

try:
    import serial  # pyserial（esptool 的依赖，IDF 环境里一定有）
except ImportError:
    print("缺 pyserial：用 IDF 的 python 跑，或 pip install pyserial", file=sys.stderr)
    sys.exit(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="COM6")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--out", default="")
    ap.add_argument("--cmd-file", default="")
    ap.add_argument("--no-reset", action="store_true", help="打开时不要拉 DTR/RTS（默认就是这个行为）")
    a = ap.parse_args()

    ser = serial.Serial()
    ser.port = a.port
    ser.baudrate = a.baud
    ser.timeout = 0.2
    # 关键：先关掉流控和自动复位信号
    ser.dtr = False
    ser.rts = False
    ser.open()
    ser.dtr = False
    ser.rts = False

    out = open(a.out, "wb") if a.out else None
    t0 = time.time()
    sent = 0
    last_cmd_poll = 0.0
    try:
        while time.time() - t0 < a.seconds:
            chunk = ser.read(4096)
            if chunk:
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
                if out:
                    out.write(chunk)
                    out.flush()
            # 轮询命令文件（每 200ms）
            if a.cmd_file and time.time() - last_cmd_poll > 0.2:
                last_cmd_poll = time.time()
                if os.path.exists(a.cmd_file):
                    try:
                        with open(a.cmd_file, "r", encoding="utf-8") as f:
                            line = f.read().strip()
                        os.remove(a.cmd_file)
                        if line:
                            ser.write((line + "\r\n").encode("utf-8"))
                            ser.flush()
                            sent += 1
                            sys.stdout.write(f"\n[serial_tap] >> {line}\n")
                    except OSError:
                        pass
    except KeyboardInterrupt:
        pass
    finally:
        if out:
            out.close()
        ser.close()
    print(f"\n[serial_tap] 结束：{time.time()-t0:.1f}s，发送 {sent} 条")
    return 0


if __name__ == "__main__":
    sys.exit(main())
