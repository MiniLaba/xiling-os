from __future__ import annotations

import hashlib
import json
import math
import shutil
import time
import urllib.parse
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol


class ConnectorError(RuntimeError):
    pass


@dataclass(frozen=True)
class DownloadedArtifact:
    path: Path
    sha256: str
    bytes: int


class ConnectorAdapter(Protocol):
    def download(self, request: dict[str, Any], output: Path, credentials: dict[str, str], max_bytes: int | None = None) -> list[Path]: ...


def _canonical_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _metadata_result(request: dict[str, Any], *, selected_shape: list[int], bytes_per_value: int,
                     variables: list[dict[str, str]], estimate_kind: str, estimated_bytes: int | None,
                     estimation_method: str, source_payload: Any) -> dict[str, Any]:
    return {
        "selectedShape": selected_shape,
        "bytesPerValue": bytes_per_value,
        "variables": variables,
        "estimateKind": estimate_kind,
        **({"estimatedBytes": estimated_bytes} if estimated_bytes is not None else {}),
        "estimationMethod": estimation_method,
        "sourceHash": _canonical_hash(source_payload),
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "live",
        "provider": request["connectorId"],
    }


def _read_bytes(url: str, timeout: int = 30) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "XiLingOS/0.1 metadata-probe (research; contact local-user)"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if response.status != 200:
                    raise ConnectorError(f"metadata endpoint returned HTTP {response.status}")
                return response.read(4_000_000)
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == 2:
                raise ConnectorError(f"metadata endpoint returned HTTP {error.code}") from error
            retry_after = error.headers.get("Retry-After", "1")
            try: delay = min(10.0, max(0.5, float(retry_after)))
            except ValueError: delay = 1.0 * (attempt + 1)
            time.sleep(delay)
        except urllib.error.URLError as error:
            if attempt == 2:
                raise ConnectorError(f"metadata network error: {error.reason}") from error
            time.sleep(0.5 * (attempt + 1))
    raise ConnectorError("metadata probe exhausted retries")


def _read_json(url: str, timeout: int = 30) -> Any:
    payload = _read_bytes(url, timeout)
    if len(payload) >= 4_000_000:
        raise ConnectorError("metadata response exceeded 4 MB")
    return json.loads(payload.decode("utf-8"))


def _request_fraction(name: str, actual_min: float, actual_max: float, request: dict[str, Any]) -> float:
    if actual_max <= actual_min:
        return 1.0
    if name in {"longitude", "lon", "x"}:
        wanted = (request["region"]["west"], request["region"]["east"])
    elif name in {"latitude", "lat", "y"}:
        wanted = (request["region"]["south"], request["region"]["north"])
    elif name in {"depth", "altitude", "z"} and request.get("depth"):
        wanted = (request["depth"]["min"], request["depth"]["max"])
    elif name == "time":
        try:
            start = datetime.fromisoformat(request["time"]["start"].replace("Z", "+00:00")).replace(tzinfo=timezone.utc).timestamp()
            end = datetime.fromisoformat(request["time"]["end"].replace("Z", "+00:00")).replace(tzinfo=timezone.utc).timestamp()
            wanted = (start, end)
        except (TypeError, ValueError):
            return 1.0
    else:
        return 1.0
    overlap = max(0.0, min(actual_max, wanted[1]) - max(actual_min, wanted[0]))
    return min(1.0, max(1e-12, overlap / (actual_max - actual_min)))


def probe_erddap(request: dict[str, Any]) -> dict[str, Any]:
    dataset = urllib.parse.quote(request["datasetId"], safe="")
    url = f"https://coastwatch.noaa.gov/erddap/griddap/{dataset}.ncml"
    xml = _read_bytes(url)
    root = ET.fromstring(xml)
    ns = {"nc": "https://www.unidata.ucar.edu/namespaces/netcdf/ncml-2.2"}
    dimensions: dict[str, int] = {}
    selected: list[int] = []
    for element in root.findall("nc:dimension", ns):
        name, length = element.attrib.get("name", ""), int(element.attrib.get("length", "1"))
        dimensions[name] = length
        range_element = root.find(f'nc:variable[@name="{name}"]/nc:attribute[@name="actual_range"]', ns)
        fraction = 1.0
        if range_element is not None:
            values = range_element.attrib.get("value", "").split()
            try:
                if len(values) >= 2:
                    fraction = _request_fraction(name.lower(), float(values[0]), float(values[1]), request)
            except ValueError:
                fraction = 1.0
        selected.append(max(1, math.ceil(length * fraction)))
    variable_rows: list[dict[str, str]] = []
    for name in request["variables"]:
        variable = root.find(f'nc:variable[@name="{name}"]', ns)
        if variable is None:
            raise ConnectorError(f"ERDDAP variable not found: {name}")
        unit = variable.find('nc:attribute[@name="units"]', ns)
        variable_rows.append({"name": name, "units": unit.attrib.get("value", "unknown") if unit is not None else "unknown"})
    payload_bytes = math.prod(selected) * len(request["variables"]) * 8
    estimated = max(65_536, math.ceil(payload_bytes * 1.2))
    source = {"url": url, "dimensions": dimensions, "selected": selected, "variables": variable_rows}
    return _metadata_result(request, selected_shape=selected, bytes_per_value=8, variables=variable_rows,
                            estimate_kind="estimated", estimated_bytes=estimated,
                            estimation_method="ERDDAP NcML dimensions × coordinate-range fraction plus container overhead", source_payload=source)


def build_erddap_subset_url(request: dict[str, Any], xml: bytes) -> str:
    root = ET.fromstring(xml)
    ns = {"nc": "https://www.unidata.ucar.edu/namespaces/netcdf/ncml-2.2"}
    ranges: dict[str, tuple[str, str]] = {}
    for dimension in root.findall("nc:dimension", ns):
        name = dimension.attrib.get("name", "")
        item = root.find(f'nc:variable[@name="{name}"]/nc:attribute[@name="actual_range"]', ns)
        values = item.attrib.get("value", "").split() if item is not None else []
        if len(values) >= 2:
            ranges[name] = (values[0], values[1])

    def bounds(name: str) -> tuple[Any, Any]:
        lowered = name.lower()
        if lowered in {"longitude", "lon", "x"}:
            return request["region"]["west"], request["region"]["east"]
        if lowered in {"latitude", "lat", "y"}:
            return request["region"]["south"], request["region"]["north"]
        if lowered == "time":
            start, end = request["time"]["start"], request["time"]["end"]
            return (start if "T" in start else f"{start}T00:00:00Z", end if "T" in end else f"{end}T00:00:00Z")
        if lowered in {"depth", "level", "altitude", "z"} and request.get("depth"):
            return request["depth"]["min"], request["depth"]["max"]
        if name in ranges:
            return ranges[name]
        raise ConnectorError(f"ERDDAP dimension has no selectable range: {name}")

    expressions: list[str] = []
    for variable_name in request["variables"]:
        variable = root.find(f'nc:variable[@name="{variable_name}"]', ns)
        if variable is None:
            raise ConnectorError(f"ERDDAP variable not found: {variable_name}")
        shape = variable.attrib.get("shape", "").split()
        if not shape:
            raise ConnectorError(f"ERDDAP variable has no dimensions: {variable_name}")
        expression = variable_name
        for dimension in shape:
            minimum, maximum = bounds(dimension)
            expression += f"[({minimum}):1:({maximum})]"
        expressions.append(expression)
    extension = {"NetCDF": "nc", "CSV": "csv", "Zarr": "nc"}[request["outputFormat"]]
    dataset = urllib.parse.quote(request["datasetId"], safe="")
    query = urllib.parse.quote(",".join(expressions), safe="[],():,._+-")
    return f"https://coastwatch.noaa.gov/erddap/griddap/{dataset}.{extension}?{query}"


def _download_to_file(url: str, target: Path, max_bytes: int | None = None) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "XiLingOS/0.1 approved-download (research; contact local-user)"})
    for attempt in range(4):
        try:
            received = 0
            with urllib.request.urlopen(request, timeout=60) as response, target.open("wb") as output:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    received += len(chunk)
                    if max_bytes is not None and received > max_bytes:
                        raise ConnectorError(f"download exceeded the approved volume budget ({max_bytes} bytes)")
                    output.write(chunk)
            if target.stat().st_size <= 0:
                raise ConnectorError("ERDDAP returned an empty subset")
            return
        except urllib.error.HTTPError as error:
            target.unlink(missing_ok=True)
            if error.code == 429 and attempt < 3:
                retry_after = error.headers.get("Retry-After", "1")
                try: delay = min(15.0, max(1.0, float(retry_after)))
                except ValueError: delay = 1.0 * (2 ** attempt)
                time.sleep(delay)
                continue
            raise ConnectorError(f"ERDDAP subset endpoint returned HTTP {error.code}") from error
        except urllib.error.URLError as error:
            target.unlink(missing_ok=True)
            if attempt < 3:
                time.sleep(1.0 * (2 ** attempt))
                continue
            raise ConnectorError(f"ERDDAP subset network error: {error.reason}") from error


def probe_argo(request: dict[str, Any]) -> dict[str, Any]:
    DataFetcher = load_argopy_data_fetcher()
    region, time = request["region"], request["time"]
    depth = request.get("depth") or {"min": 0, "max": 2000}
    box = [region["west"], region["east"], region["south"], region["north"], depth["min"], depth["max"], time["start"], time["end"]]
    uris = list(DataFetcher(src="gdac", mode="research", parallel=False).region(box).uri)
    profiles = len(uris)
    levels = max(1, min(2001, math.ceil(depth["max"] - depth["min"] + 1)))
    selected = [profiles, levels]
    estimated = profiles * levels * len(request["variables"]) * 8
    variables = [{"name": name, "units": "degree_Celsius" if name.upper() == "TEMP" else "unknown"} for name in request["variables"]]
    return _metadata_result(request, selected_shape=selected, bytes_per_value=8, variables=variables,
                            estimate_kind="estimated", estimated_bytes=estimated,
                            estimation_method="GDAC index file count × requested depth levels; NetCDF overhead excluded",
                            source_payload={"box": box, "uriCount": profiles, "variables": variables})


def probe_copernicus(request: dict[str, Any], credentials: dict[str, str]) -> dict[str, Any]:
    import copernicusmarine
    username, password = credentials.get("username"), credentials.get("password")
    if not username or not password:
        raise ConnectorError("Copernicus credentials are required")
    region, time, depth = request["region"], request["time"], request.get("depth")
    kwargs: dict[str, Any] = {
        "dataset_id": request["datasetId"], "variables": request["variables"],
        "minimum_longitude": region["west"], "maximum_longitude": region["east"],
        "minimum_latitude": region["south"], "maximum_latitude": region["north"],
        "start_datetime": time["start"], "end_datetime": time["end"],
        "username": username, "password": password, "dry_run": True,
        "disable_progress_bar": True, "file_format": "netcdf",
    }
    if depth:
        kwargs.update({"minimum_depth": depth["min"], "maximum_depth": depth["max"]})
    response = copernicusmarine.subset(**kwargs)
    size_mb = response.file_size
    estimated = None if size_mb is None else max(1, math.ceil(size_mb * 1_000_000))
    variables = [{"name": name, "units": "unknown"} for name in response.variables]
    source = {"datasetId": request["datasetId"], "variables": response.variables,
              "extent": [item.model_dump(mode="json") for item in response.coordinates_extent], "fileSizeMB": size_mb}
    return _metadata_result(request, selected_shape=[], bytes_per_value=4, variables=variables,
                            estimate_kind="estimated" if estimated is not None else "unknown", estimated_bytes=estimated,
                            estimation_method="Copernicus Marine official subset(dry_run=True) file_size",
                            source_payload=source)


def probe_harmony(request: dict[str, Any], credentials: dict[str, str]) -> dict[str, Any]:
    token = credentials.get("token")
    if not token and not (credentials.get("username") and credentials.get("password")):
        raise ConnectorError("NASA Earthdata credentials are required")
    collection = urllib.parse.quote(request["datasetId"], safe="")
    payload = _read_json(f"https://harmony.earthdata.nasa.gov/capabilities?collectionId={collection}&version=2")
    variables = [{"name": name, "units": "unknown"} for name in request["variables"]]
    # Harmony capabilities intentionally does not promise result volume. Do not
    # invent a byte count; the server blocks approval until a later estimate exists.
    return _metadata_result(request, selected_shape=[], bytes_per_value=4, variables=variables,
                            estimate_kind="unknown", estimated_bytes=None,
                            estimation_method="Harmony capabilities exposes operations but no result-size estimate",
                            source_payload={"collection": request["datasetId"], "capabilities": payload})


def probe_metadata(request: dict[str, Any], credentials: dict[str, str]) -> dict[str, Any]:
    validate_request(request)
    if request["connectorId"] == "erddap":
        return probe_erddap(request)
    if request["connectorId"] == "argo-gdac":
        return probe_argo(request)
    if request["connectorId"] == "copernicus-marine":
        return probe_copernicus(request, credentials)
    return probe_harmony(request, credentials)


def validate_request(request: dict[str, Any]) -> None:
    required = {"connectorId", "datasetId", "variables", "region", "time", "outputFormat"}
    if not required.issubset(request):
        raise ConnectorError(f"missing request fields: {sorted(required - set(request))}")
    if request["connectorId"] not in {"erddap", "argo-gdac", "copernicus-marine", "nasa-harmony"}:
        raise ConnectorError("unsupported connector")
    if not isinstance(request["variables"], list) or not request["variables"]:
        raise ConnectorError("at least one variable is required")
    region = request["region"]
    if not (-180 <= region["west"] < region["east"] <= 180 and -90 <= region["south"] < region["north"] <= 90):
        raise ConnectorError("invalid geographic bounds")
    if request["time"]["start"] > request["time"]["end"]:
        raise ConnectorError("invalid time range")
    depth = request.get("depth")
    if depth and not (0 <= depth["min"] <= depth["max"]):
        raise ConnectorError("invalid depth range")


def build_execution_spec(request: dict[str, Any]) -> dict[str, Any]:
    """Create a secret-free, deterministic plan. This function performs no I/O."""
    validate_request(request)
    region = request["region"]
    time = request["time"]
    depth = request.get("depth") or {"min": 0, "max": 0}
    common = {
        "datasetId": request["datasetId"],
        "variables": list(request["variables"]),
        "bbox": [region["west"], region["south"], region["east"], region["north"]],
        "time": [time["start"], time["end"]],
        "depth": [depth["min"], depth["max"]],
        "outputFormat": request["outputFormat"],
    }
    provider = request["connectorId"]
    if provider == "erddap":
        operation = {"client": "ERDDAP REST", "protocol": "griddap", "server": "https://coastwatch.noaa.gov/erddap", **common}
    elif provider == "argo-gdac":
        operation = {"client": "argopy", "source": "gdac", "parallel": False, **common}
    elif provider == "copernicus-marine":
        operation = {"client": "copernicusmarine", "dryRunBeforeDownload": True, **common}
    else:
        operation = {"client": "harmony-py", "maxResults": 10, "asynchronous": True, **common}
    canonical = json.dumps(operation, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return {"version": 1, "provider": provider, "operation": operation, "planHash": hashlib.sha256(canonical).hexdigest()}


class ErddapAdapter:
    def download(self, request: dict[str, Any], output: Path, credentials: dict[str, str], max_bytes: int | None = None) -> list[Path]:
        del credentials
        response = {"NetCDF": "nc", "CSV": "csv", "Zarr": "nc"}[request["outputFormat"]]
        target = output / f"subset.{response}"
        dataset = urllib.parse.quote(request["datasetId"], safe="")
        xml = _read_bytes(f"https://coastwatch.noaa.gov/erddap/griddap/{dataset}.ncml")
        _download_to_file(build_erddap_subset_url(request, xml), target, max_bytes)
        return [target]


class ArgoAdapter:
    def download(self, request: dict[str, Any], output: Path, credentials: dict[str, str], max_bytes: int | None = None) -> list[Path]:
        del credentials
        DataFetcher = load_argopy_data_fetcher()

        region, time = request["region"], request["time"]
        depth = request.get("depth") or {"min": 0, "max": 2000}
        box = [region["west"], region["east"], region["south"], region["north"], depth["min"], depth["max"], time["start"], time["end"]]
        dataset = DataFetcher(src="gdac", mode="research", parallel=False).region(box).to_xarray(errors="raise")
        selected = [name for name in request["variables"] if name in dataset]
        if not selected:
            raise ConnectorError("none of the requested Argo variables were returned")
        target = output / "argo-subset.nc"
        dataset[selected].to_netcdf(target)
        return [target]


class CopernicusAdapter:
    def download(self, request: dict[str, Any], output: Path, credentials: dict[str, str], max_bytes: int | None = None) -> list[Path]:
        import copernicusmarine

        username, password = credentials.get("username"), credentials.get("password")
        if not username or not password:
            raise ConnectorError("Copernicus credentials are required")
        region, time = request["region"], request["time"]
        depth = request.get("depth")
        extension = {"NetCDF": "nc", "Zarr": "zarr", "CSV": "csv"}[request["outputFormat"]]
        kwargs: dict[str, Any] = {
            "dataset_id": request["datasetId"], "variables": request["variables"],
            "minimum_longitude": region["west"], "maximum_longitude": region["east"],
            "minimum_latitude": region["south"], "maximum_latitude": region["north"],
            "start_datetime": time["start"], "end_datetime": time["end"],
            "username": username, "password": password, "output_directory": output,
            "output_filename": f"copernicus-subset.{extension}", "file_format": extension if extension != "nc" else "netcdf",
            "disable_progress_bar": True, "overwrite": False,
        }
        if depth:
            kwargs.update({"minimum_depth": depth["min"], "maximum_depth": depth["max"]})
        copernicusmarine.subset(**kwargs)
        return [output / f"copernicus-subset.{extension}"]


class HarmonyAdapter:
    def download(self, request: dict[str, Any], output: Path, credentials: dict[str, str], max_bytes: int | None = None) -> list[Path]:
        from harmony import BBox, Client, Collection, Request

        token = credentials.get("token")
        auth = None if token else (credentials.get("username"), credentials.get("password"))
        if not token and (not auth[0] or not auth[1]):
            raise ConnectorError("NASA Earthdata token or username/password is required")
        client = Client(token=token) if token else Client(auth=auth)
        region, time = request["region"], request["time"]
        job_request = Request(
            collection=Collection(id=request["datasetId"]), variables=request["variables"],
            spatial=BBox(region["west"], region["south"], region["east"], region["north"]),
            temporal={"start": time["start"], "stop": time["end"]}, max_results=10,
        )
        job_id = client.submit(job_request)
        try:
            client.wait_for_processing(job_id, show_progress=False, timeout=1500)
        except TypeError:  # harmony-py builds without the timeout kwarg
            client.wait_for_processing(job_id, show_progress=False)
        return [Path(future.result()) for future in client.download_all(job_id, directory=output, overwrite=False)]


ADAPTERS: dict[str, ConnectorAdapter] = {
    "erddap": ErddapAdapter(), "argo-gdac": ArgoAdapter(),
    "copernicus-marine": CopernicusAdapter(), "nasa-harmony": HarmonyAdapter(),
}


def load_argopy_data_fetcher():
    """Bridge argopy 1.4.0 to erddapy 3.3's public module layout.

    Remove when argopy no longer imports the legacy private location. Keeping this
    inside the selected adapter avoids import-time network/schema cost elsewhere.
    """
    import erddapy.erddapy as legacy_erddapy
    if not hasattr(legacy_erddapy, "_quote_string_constraints"):
        from erddapy.core.url import _quote_string_constraints
        legacy_erddapy._quote_string_constraints = _quote_string_constraints
    from argopy import DataFetcher
    return DataFetcher


def execute_download(request: dict[str, Any], workspace: Path, credentials: dict[str, str], fixture_source: Path | None = None, max_bytes: int | None = None) -> dict[str, Any]:
    validate_request(request)
    output = workspace.resolve() / "artifacts"
    output.mkdir(parents=True, exist_ok=True)
    if fixture_source is not None:
        source = fixture_source.resolve()
        if not source.is_file():
            raise ConnectorError("fixture source is not a file")
        paths = [Path(shutil.copyfile(source, output / source.name))]
        source_kind = "fixture"
    else:
        paths = ADAPTERS[request["connectorId"]].download(request, output, credentials, max_bytes)
        source_kind = "live"
    artifacts: list[DownloadedArtifact] = []
    for path in paths:
        resolved = path.resolve()
        if output not in resolved.parents or not resolved.is_file():
            raise ConnectorError("connector returned an unsafe artifact path")
        digest = hashlib.sha256(resolved.read_bytes()).hexdigest()
        artifacts.append(DownloadedArtifact(resolved, digest, resolved.stat().st_size))
    if max_bytes is not None and sum(item.bytes for item in artifacts) > max_bytes:
        raise ConnectorError(f"download exceeded the approved volume budget ({max_bytes} bytes)")
    return {
        "source": source_kind,
        "plan": build_execution_spec(request),
        "outputs": [{"path": item.path.relative_to(output).as_posix(), "sha256": item.sha256, "bytes": item.bytes} for item in artifacts],
    }
