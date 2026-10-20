# Experimental Awair and PurpleAir readings

These optional read-only adapters have fixture evidence only. No physical model,
firmware or cloud account has been verified. They cannot control an appliance,
enumerate nearby sensors, access history, change registration or expose a map.
Their supported-action lists are empty.

## Awair Home personal access

The `awair` adapter follows the official
[Awair Home API documentation](https://docs.developer.getawair.com/). Its sole
request is a selected device's latest AirData, with `fahrenheit=false`, at
`https://developer-apis.awair.is`. Authentication is an owner's personal Bearer
Token obtained through the Awair Home Developer Console, entered locally.
OAuth application tokens and Business/Dashboard credentials are separate flows
and are not implemented here.

The accepted device-type identifiers are `awair-r2` and `awair-element`.
Supported numeric components are `temp` (Celsius), `humid` (RH percentage),
`co2` (ppm), `voc` (ppb) and `pm25` (micrograms per cubic metre). Scores,
indices, names and location metadata are excluded. Empty latest-data arrays
represent missing/disconnected data and are rejected rather than freshened.
The documentation describes a Hobbyist latest-data quota of 300 requests per
device per endpoint per UTC day. Five-minute polling is 288 attempts per day
for one continuously running adapter; other processes and clients also count.
Availability and quota remain controlled by Awair.

Owner metadata contains `vendorDeviceId` (positive integer), `deviceType` and an
optional `timeoutMs`; authentication is `token` in trusted process memory.
`protectAwairConfig` produces `credentialSecret`, and `loadAwairConfig` accepts
only the encrypted configuration. The credential purpose binds the fixed
official origin, global service, selected device type and exact device number.

## PurpleAir public sensor access

The `purpleair` adapter uses the official
[Get Sensor Data API](https://api.purpleair.com/#api-sensors-get-sensor-data).
It sends a READ API key in `X-API-Key` to `https://api.purpleair.com` and requests
only `last_seen,temperature,humidity,pm2.5_atm` for one enrolled sensor index.
There is no bounding-box search, account enumeration or historical request.

The projection follows the vendor's
[field definitions](https://community.purpleair.com/t/api-fields-descriptions/4652):

| Hub value | Meaning |
| --- | --- |
| `sensorHousingTemperatureC` | Reported housing Fahrenheit converted arithmetically to Celsius; no ambient correction |
| `sensorHousingHumidityPercent` | Reported relative humidity inside the housing |
| `pm25AtmosphericUgM3` | Vendor's ATM PM2.5 estimate in micrograms per cubic metre |

These are not ambient-temperature estimates or calculated AQI values. Null
optional measurements are omitted; malformed/nonfinite/out-of-range values are
rejected. Returned `sensor_index` must match enrollment. Coordinates, names,
raw hardware details and registration information never enter Hub state.

The API uses a [points billing system](https://community.purpleair.com/t/api-pricing/4523).
The owner needs a READ key with appropriate project points/permissions before
enabling reads. Sensor owners can review the vendor's
[owner points assistance](https://community.purpleair.com/t/api-points-for-sensor-owners/7525).
Do not assume requests are free or purchase points automatically. Polls and
manual refreshes share the same five-minute per-adapter attempt limit; it is
not an account-wide spending cap.

Only publicly registered sensors are supported by this path. The official API
requires a separate `read_key` query parameter for privately registered devices.
This project's secret-free URL policy excludes that flow: `read_key`, `readKey`,
custom query fields and custom origins are rejected. Use another reviewed
local/bridge integration for private sensor access; never publish a private
sensor to make this adapter work.

Owner metadata contains `vendorDeviceId` (positive integer) and optional
`timeoutMs`; authentication is `apiKey` in trusted process memory.
`protectPurpleAirConfig` and `loadPurpleAirConfig` protect/restore only the exact
fixed-origin public-sensor binding using `credentialSecret`.

## Source age and privacy

Both adapters use the [trusted masked enrollment](POPULAR_ADAPTERS.md) flow and
Windows CurrentUser DPAPI in production. Authentication never belongs in model
messages, command arguments, metadata JSON, URLs or environment variables.
There is no production plaintext or fixture-provider fallback. Node built-ins
and the reviewed fixed-origin HTTPS client are sufficient; no new SDK is needed.
Normal system certificate trust and hostname verification remain enabled.

Awair's timestamp must be a valid UTC ISO timestamp. PurpleAir's response,
database-load and `last_seen` values must be finite positive integer Unix
seconds, ordered consistently; database-load time may lag response time by at
most 30 seconds. A sample with a future timestamp, a missing timestamp or age
of ten minutes or more is rejected. Cloud/server reports still do not prove
sensor calibration or physical accuracy.

`fields.environment.observedAt` preserves the validated reported timestamp.
Expiry is the earlier of five minutes after the local attempt and ten minutes
after the source timestamp. Cached older samples therefore cannot acquire a
fresh five-minute source lifetime on every request. Failed reads expire prior
evidence and do not freshen observation time. The shared five-minute attempt
limit also applies to failed and manual reads.

## Deferred: Airthings OAuth lifecycle

The official [Airthings consumer API setup](https://help.airthings.com/en/articles/4510990-integrations-airthings-api)
requires creating an application with a client ID and secret; current consumer
documentation is linked through that vendor setup. AnyAdapter does not yet have
a reviewed token-exchange and renewal lifecycle for this vendor. That needs a
fixed token endpoint, bounded authenticated POST, scope/device binding, token
expiry handling, concurrent renewal control and safe credential rotation.
Passing a copied temporary access token as permanent enrollment would leave
that lifecycle incomplete, so no Airthings adapter is registered by this work.
Existing reviewed bridge support remains a separate option.
