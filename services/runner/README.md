# Scientific Runner

Runner 始终位于受控 Linux 容器，默认用户为非 root。Node 宿主通过 `docker create` / `docker cp` / `docker start --attach` 驱动一次性入口脚本（`run_ocean_analysis.py`、`run_connector.py`），容器内不暴露任何长驻监听端口；离线 smoke 直接调用相同的分析模块，验证 xarray、Artifact 和 RO-Crate 最短路径。

```sh
docker build -t xiling-runner:research-os services/runner
docker run --rm --network none xiling-runner:research-os python smoke.py
docker run --rm --network none xiling-runner:research-os python ocean_smoke.py
docker run --rm --network none xiling-runner:research-os python connector_smoke.py
```

运行时只挂载已批准的项目快照目录，不挂载宿主凭据、Docker socket 或任意 Windows 盘符。

连接器生产执行使用 `run_connector.py`。无密钥计划通过 `--mode plan` 生成；只有批准后的 `--mode download` 才读取标准输入中的一次性凭据 JSON。凭据不会出现在命令行、计划文件、Artifact 或容器环境变量中。批准锁定的体积估算通过 `--max-bytes` 传入，下载超过预算会在容器内立即失败。
