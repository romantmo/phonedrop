/*! @cloudflare/speedtest 1.17.0 — https://github.com/cloudflare/speedtest — MIT License, Copyright (c) 2023 Cloudflare.
    Движок замера скорости до ближайшего узла Cloudflare (тот же, что на speed.cloudflare.com). */
//#region src/config/defaultConfig.ts
const REL_API_URL = "https://speed.cloudflare.com";
const defaultConfig = {
	autoStart: true,
	downloadApiUrl: `${REL_API_URL}/__down`,
	uploadApiUrl: `${REL_API_URL}/__up`,
	measurementTargets: [],
	measurementDownloadPath: "/__down",
	measurementUploadPath: "/__up",
	logMeasurementApiUrl: null,
	logAimApiUrl: `${REL_API_URL}/__results`,
	turnServerUri: null,
	turnServerCredsApiUrl: null,
	turnServerUser: null,
	turnServerPass: null,
	rpkiInvalidHost: "invalid.rpki.cloudflare.com",
	includeCredentials: false,
	sessionId: void 0,
	authorizationToken: null,
	authorizationEnabled: void 0,
	allowInsecureAuthorizationToken: false,
	measurements: [
		{
			type: "latency",
			numPackets: 2
		},
		{
			type: "download",
			bytes: 1e5,
			count: 1,
			bypassMinDuration: true
		},
		{
			type: "latency",
			numPackets: 20
		},
		{
			type: "download",
			bytes: 1e5,
			count: 9
		},
		{
			type: "latency",
			numPackets: 2
		},
		{
			type: "download",
			bytes: 1e6,
			count: 8
		},
		{
			type: "latency",
			numPackets: 2
		},
		{
			type: "upload",
			bytes: 1e5,
			count: 8
		},
		{
			type: "latency",
			numPackets: 2
		},
		{
			type: "upload",
			bytes: 1e6,
			count: 6
		},
		{
			type: "latency",
			numPackets: 2
		},
		{
			type: "download",
			bytes: 1e7,
			count: 6
		},
		{
			type: "latency",
			numPackets: 2
		},
		{
			type: "upload",
			bytes: 1e7,
			count: 4
		},
		{
			type: "latency",
			numPackets: 2
		},
		{
			type: "download",
			bytes: 25e6,
			count: 4
		},
		{
			type: "latency",
			numPackets: 2
		},
		{
			type: "upload",
			bytes: 25e6,
			count: 4
		},
		{
			type: "latency",
			numPackets: 2
		},
		{
			type: "download",
			bytes: 1e8,
			count: 3
		},
		{
			type: "latency",
			numPackets: 2
		},
		{
			type: "upload",
			bytes: 5e7,
			count: 3
		},
		{
			type: "latency",
			numPackets: 2
		},
		{
			type: "download",
			bytes: 25e7,
			count: 2
		}
	],
	measureDownloadLoadedLatency: true,
	measureUploadLoadedLatency: true,
	loadedLatencyThrottle: 400,
	bandwidthFinishRequestDuration: 1e3,
	estimatedServerTime: 0,
	abortRequestDuration: 0,
	abortTestDuration: 0,
	latencyPercentile: .5,
	bandwidthPercentile: .9,
	bandwidthMinRequestDuration: 10,
	loadedRequestMinDuration: 250,
	loadedLatencyMaxPoints: 20
};
//#endregion
//#region src/utils/scaleThreshold.ts
const scaleThreshold = (domain, range) => {
	return (value) => {
		let i = 0;
		while (i < domain.length && value >= domain[i]) i++;
		return range[i];
	};
};
//#endregion
//#region src/config/internalConfig.ts
const internalConfig = {
	aimMeasurementScoring: {
		packetLoss: scaleThreshold([
			.01,
			.05,
			.25,
			.5
		], [
			10,
			5,
			0,
			-10,
			-20
		]),
		latency: scaleThreshold([
			10,
			20,
			50,
			100,
			500
		], [
			20,
			10,
			5,
			0,
			-10,
			-20
		]),
		loadedLatencyIncrease: scaleThreshold([
			10,
			20,
			50,
			100,
			500
		], [
			20,
			10,
			5,
			0,
			-10,
			-20
		]),
		jitter: scaleThreshold([
			10,
			20,
			100,
			500
		], [
			10,
			5,
			0,
			-10,
			-20
		]),
		download: scaleThreshold([
			1e6,
			1e7,
			5e7,
			1e8
		], [
			0,
			5,
			10,
			20,
			30
		]),
		upload: scaleThreshold([
			1e6,
			1e7,
			5e7,
			1e8
		], [
			0,
			5,
			10,
			20,
			30
		])
	},
	aimExperiencesDefs: {
		streaming: {
			input: [
				"latency",
				"packetLoss",
				"download",
				"loadedLatencyIncrease"
			],
			pointThresholds: [
				15,
				20,
				40,
				60
			]
		},
		gaming: {
			input: [
				"latency",
				"packetLoss",
				"loadedLatencyIncrease"
			],
			pointThresholds: [
				5,
				15,
				25,
				30
			]
		},
		rtc: {
			input: [
				"latency",
				"jitter",
				"packetLoss",
				"loadedLatencyIncrease"
			],
			pointThresholds: [
				5,
				15,
				25,
				40
			]
		}
	}
};
//#endregion
//#region src/utils/authorization.ts
const isSecureApiUrl = (apiUrl) => {
	try {
		return new URL(apiUrl).protocol === "https:";
	} catch {
		try {
			return new URL(apiUrl, window.location.origin).protocol === "https:";
		} catch {
			return false;
		}
	}
};
const warnedInsecure = new WeakSet();
const warnInsecureOnce = (authorization) => {
	if (warnedInsecure.has(authorization)) return;
	warnedInsecure.add(authorization);
	console.warn("Sending the authorization token to an endpoint that is not known to be secure, because allowInsecureAuthorizationToken is enabled. Do not enable this outside local development: the server treats a token seen over plaintext as compromised and revokes it.");
};
const withAuthorizationHeader = (init, authorization, apiUrl) => {
	if (!authorization?.enabled || !apiUrl) return init;
	const token = authorization.token?.trim();
	if (!token) return init;
	if (!isSecureApiUrl(apiUrl)) {
		if (!authorization.allowInsecure) return init;
		warnInsecureOnce(authorization);
	}
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	return {
		...init,
		headers: Object.fromEntries(headers)
	};
};
//#endregion
//#region src/engines/BandwidthEngine/BandwidthEngine.ts
const MAX_RETRIES = 3;
var HttpError = class extends Error {
	status;
	retryAfter;
	constructor(status, statusText, retryAfter) {
		super(statusText);
		this.status = status;
		this.retryAfter = retryAfter;
	}
};
const getRetryDelay = (retryAfter) => {
	if (!retryAfter) return 5e3;
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1e3;
	const date = Date.parse(retryAfter);
	return Number.isNaN(date) ? 5e3 : Math.max(0, date - Date.now());
};
const SERVER_TIME_MIN_DURATION = .01;
const SERVER_TIME_DELTA_MAX = 15;
const SERVER_TIME_CALIBRATION_MAX = 150;
const SERVER_TIME_DELTA_WEIGHT = .75;
const cfGetServerTime = (r) => {
	const serverTiming = r.headers.get(`server-timing`);
	if (!serverTiming) return;
	const re = serverTiming.match(/(?:^|,\s*)cfReq(?:uest)?Dur(?:ation)?;\s*dur=([0-9.]+)/i);
	if (re && +re[1] > SERVER_TIME_MIN_DURATION) return +re[1];
	let sum = 0;
	for (const m of serverTiming.matchAll(/(?:^|,\s*)cfSpeed[a-zA-Z]*;\s*dur=([0-9.]+)/gi)) sum += +m[1];
	if (sum > SERVER_TIME_MIN_DURATION) return sum;
};
const getFinalResponseStart = (perf) => perf.finalResponseHeadersStart || perf.responseStart;
const MAX_MISSING_ENTRIES = 3;
const getRequestEntries = (url, since) => performance.getEntriesByName(url).filter((entry) => entry.startTime >= since);
const hasDetailedTiming = (perf) => perf.requestStart !== 0 || perf.responseStart !== 0;
const getTtfb = (perf) => getFinalResponseStart(perf) - perf.requestStart;
const calcDownloadSpeed = ({ duration, transferSize }, numBytes) => {
	const bits = 8 * (transferSize || +numBytes * 1.005);
	const secs = duration / 1e3;
	return !secs ? void 0 : bits / secs;
};
const calcUploadSpeed = ({ duration }, numBytes) => {
	const bits = 8 * numBytes * 1.005;
	const secs = duration / 1e3;
	return !secs ? void 0 : bits / secs;
};
const hasUsableSpeed = ({ bps }, numBytes) => +numBytes === 0 || typeof bps === "number" && Number.isFinite(bps) && bps > 0;
const genContent = (() => {
	const cache = new Map();
	return (numBytes) => {
		if (!cache.has(numBytes)) cache.set(numBytes, "0".repeat(numBytes));
		return cache.get(numBytes);
	};
})();
const BODY_TAIL_BYTES = 1024;
const readBodyTail = async (r) => {
	if (!r.body) return "";
	const reader = r.body.getReader();
	let tail = new Uint8Array(0);
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value.length >= BODY_TAIL_BYTES) tail = value.slice(-1024);
		else {
			const merged = new Uint8Array(tail.length + value.length);
			merged.set(tail);
			merged.set(value, tail.length);
			tail = merged.slice(-1024);
		}
	}
	return new TextDecoder().decode(tail);
};
const getParallelism = ({ parallel }) => typeof parallel === "number" && Number.isFinite(parallel) && parallel >= 1 ? Math.floor(parallel) : 1;
const getSampleBytes = (meas) => meas.bytes * getParallelism(meas);
const aggregateBatchTiming = (requests, { isDown, numBytes, estimatedServerTime = 0, serverTimeDelta = 0 }) => {
	const perRequest = requests.map(({ perf, serverTime }) => {
		const finalStart = getFinalResponseStart(perf);
		const ttfb = finalStart - perf.requestStart;
		const baseServerTime = serverTime || estimatedServerTime;
		let ping = ttfb - baseServerTime - serverTimeDelta;
		if (ping <= 1) ping = Math.max(0, ttfb - baseServerTime);
		return {
			ttfb,
			ping,
			serverAdjustment: ttfb - ping,
			finalStart
		};
	});
	const start = Math.min(...requests.map(({ perf }) => perf.requestStart));
	const lastResponseEnd = Math.max(...requests.map(({ perf }) => perf.responseEnd));
	const lastFinalStart = Math.max(...perRequest.map((r) => r.finalStart));
	const ping = Math.min(...perRequest.map((r) => r.ping));
	const duration = isDown ? lastResponseEnd - start - Math.min(...perRequest.map((r) => r.serverAdjustment)) : lastFinalStart - start;
	const transferSize = requests.every(({ perf }) => perf.transferSize) ? requests.reduce((sum, { perf }) => sum + perf.transferSize, 0) : 0;
	const serverTimes = requests.map(({ serverTime }) => serverTime).filter((t) => !!t);
	const totalBytes = numBytes * requests.length;
	return {
		transferSize,
		ttfb: Math.min(...perRequest.map((r) => r.ttfb)),
		payloadDownloadTime: isDown ? Math.max(0, duration - ping) : Math.max(0, lastResponseEnd - lastFinalStart),
		serverTime: serverTimes.length ? Math.min(...serverTimes) : -1,
		measTime: new Date(),
		ping,
		duration,
		bps: isDown ? calcDownloadSpeed({
			duration,
			transferSize
		}, totalBytes) : calcUploadSpeed({ duration }, totalBytes)
	};
};
const toUrlList = (url) => (Array.isArray(url) ? url : [url]).filter((u) => !!u);
var BandwidthMeasurementEngine = class {
	constructor(measurements, { downloadApiUrl, uploadApiUrl, throttleMs = 0, estimatedServerTime = 0, serverTimeDelta = 0, authorization = null } = {}) {
		if (!measurements) throw new Error("Missing measurements argument");
		const downloadApis = toUrlList(downloadApiUrl);
		const uploadApis = toUrlList(uploadApiUrl);
		if (!downloadApis.length) throw new Error("Missing downloadApiUrl argument");
		if (!uploadApis.length) throw new Error("Missing uploadApiUrl argument");
		this.#measurements = measurements;
		this.#apis = {
			down: downloadApis,
			up: uploadApis
		};
		this.#apiIdx = {
			down: Math.floor(Math.random() * downloadApis.length),
			up: Math.floor(Math.random() * uploadApis.length)
		};
		this.#throttleMs = throttleMs;
		this.#estimatedServerTime = Math.max(0, estimatedServerTime);
		this.#serverTimeDelta = Math.max(0, serverTimeDelta);
		this.#authorization = authorization;
	}
	get results() {
		return this.#results;
	}
	get serverTimeDelta() {
		return this.#serverTimeDelta;
	}
	#qsParams = {};
	get qsParams() {
		return this.#qsParams;
	}
	set qsParams(v) {
		this.#qsParams = v;
	}
	#fetchOptions = {};
	get fetchOptions() {
		return this.#fetchOptions;
	}
	set fetchOptions(v) {
		this.#fetchOptions = v;
	}
	finishRequestDuration = 1e3;
	#abortRequestDuration = 0;
	get abortRequestDuration() {
		return this.#abortRequestDuration;
	}
	set abortRequestDuration(v) {
		this.#abortRequestDuration = v;
	}
	getServerTime = cfGetServerTime;
	#responseHook = () => {};
	set responseHook(f) {
		this.#responseHook = f;
	}
	#onRunningChange = () => {};
	set onRunningChange(f) {
		this.#onRunningChange = f;
	}
	#onNewMeasurementStarted = () => {};
	set onNewMeasurementStarted(f) {
		this.#onNewMeasurementStarted = f;
	}
	#onMeasurementResult = () => {};
	set onMeasurementResult(f) {
		this.#onMeasurementResult = f;
	}
	#onFinished = () => {};
	set onFinished(f) {
		this.#onFinished = f;
	}
	#onConnectionError = () => {};
	set onConnectionError(f) {
		this.#onConnectionError = f;
	}
	#onFatalError = () => {};
	set onFatalError(f) {
		this.#onFatalError = f;
	}
	pause() {
		if (this.#retryTimeout !== void 0) {
			clearTimeout(this.#retryTimeout);
			this.#retryTimeout = void 0;
		}
		clearTimeout(this.#abortTimeout);
		clearTimeout(this.#throttleTimeout);
		this.#cancelCurrentMeasurement(`pause()`);
		this.#setRunning(false);
	}
	play() {
		if (!this.#running) {
			this.#setRunning(true);
			this.#nextMeasurement();
		}
	}
	#measurements;
	#apis;
	#apiIdx;
	#running = false;
	#finished = {
		down: false,
		up: false
	};
	#results = {
		down: {},
		up: {}
	};
	#measIdx = 0;
	#counter = 0;
	#retries = 0;
	#missingEntries = 0;
	#retryTimeout;
	#abortTimeout;
	#throttleTimeout;
	#minDuration = -Infinity;
	#throttleMs = 0;
	#estimatedServerTime = 0;
	#serverTimeDelta = 0;
	#authorization = null;
	#currentAbortController = void 0;
	#setRunning(running) {
		if (running !== this.#running) {
			this.#running = running;
			setTimeout(() => this.#onRunningChange(this.#running));
		}
		if (!running) this.#currentAbortController?.abort("setRunning(false)");
	}
	#saveMeasurementResults(measIdx, measTiming) {
		const meas = this.#measurements[measIdx];
		const { dir } = meas;
		const bytes = getSampleBytes(meas);
		const results = this.#results;
		const bytesResult = results[dir].hasOwnProperty(bytes) ? results[dir][bytes] : {
			timings: [],
			numMeasurements: this.#measurements.filter((m) => getSampleBytes(m) === bytes && m.dir === dir).map((m) => m.count).reduce((agg, cnt) => agg + cnt, 0)
		};
		measTiming && bytesResult.timings.push(measTiming);
		bytesResult.timings = bytesResult.timings.slice(-bytesResult.numMeasurements);
		results[dir][bytes] = bytesResult;
		if (measTiming) setTimeout(() => {
			this.#onMeasurementResult({
				type: dir,
				bytes,
				...measTiming
			}, results, meas);
		});
		else this.#onNewMeasurementStarted({
			...meas,
			bytes
		}, results);
	}
	#nextMeasurement() {
		const measurements = this.#measurements;
		let meas = measurements[this.#measIdx];
		if (this.#counter >= meas.count) {
			const finished = this.#finished;
			if (this.#minDuration > this.finishRequestDuration && !meas.bypassMinDuration) {
				const dir = meas.dir;
				this.#finished[dir] = true;
				Object.values(this.#finished).every((finished) => finished) && this.#onFinished(this.#results);
			}
			this.#counter = 0;
			this.#missingEntries = 0;
			this.#minDuration = -Infinity;
			do
				this.#measIdx += 1;
			while (this.#measIdx < measurements.length && finished[measurements[this.#measIdx].dir]);
			if (this.#measIdx >= measurements.length) {
				this.#finished = {
					down: true,
					up: true
				};
				this.#setRunning(false);
				this.#onFinished(this.#results);
				return;
			}
			meas = measurements[this.#measIdx];
		}
		const measIdx = this.#measIdx;
		if (this.#counter === 0) this.#saveMeasurementResults(measIdx);
		this.#runSample(meas, measIdx);
	}
	#runSample(meas, measIdx) {
		const { bytes: numBytes, dir } = meas;
		const isDown = dir === "down";
		const parallel = getParallelism(meas);
		const requests = Array.from({ length: parallel }, (_, i) => this.#buildRequest(dir, numBytes, parallel > 1 ? { req: `${i}` } : {}));
		const { signal: setSignal } = this.#prepareAbortController(parallel > 1 ? `${isDown ? "Download" : "Upload"} batch of ${parallel}x${numBytes} bytes` : `${isDown ? "Download" : "Upload"} request of ${numBytes} bytes`);
		const batchController = new AbortController();
		const abortBatch = () => batchController.abort(setSignal.reason);
		if (setSignal.aborted) abortBatch();
		else setSignal.addEventListener("abort", abortBatch, { once: true });
		const signal = batchController.signal;
		const requestedAt = performance.now();
		Promise.all(requests.map(({ url, fetchOpt }) => fetch(url, {
			...fetchOpt,
			signal
		}).then((r) => {
			if (r.ok) return r;
			throw new HttpError(r.status, r.statusText, r.headers.get("retry-after"));
		}).then(async (r) => {
			const serverTime = this.getServerTime?.(r) ?? void 0;
			this.#responseHook({
				url,
				headers: r.headers,
				body: await readBodyTail(r)
			});
			return serverTime;
		}).catch((error) => {
			if (!signal.aborted) {
				batchController.abort("batch request failed");
				this.#handleRequestError(error, url);
			}
			throw error;
		}))).then(async (serverTimes) => {
			const findEntries = () => requests.map(({ url }) => getRequestEntries(url, requestedAt));
			let entries = findEntries();
			if (entries.some((found) => !found.length)) {
				await new Promise((resolve) => setTimeout(resolve));
				entries = findEntries();
			}
			if (signal.aborted) return;
			const missingIdx = entries.findIndex((found) => !found.length);
			if (missingIdx >= 0) {
				this.#discardMissingEntry(dir, requests[missingIdx].url);
				return;
			}
			const perfs = entries.map(([perf]) => perf);
			const restrictedIdx = perfs.findIndex((perf) => !hasDetailedTiming(perf));
			if (restrictedIdx >= 0) {
				const message = `No detailed resource timing for ${requests[restrictedIdx].url}. A cross-origin target must send a Timing-Allow-Origin header.`;
				console.warn(message);
				this.#skipFailedRequest(message);
				return;
			}
			this.#missingEntries = 0;
			const batch = perfs.map((perf, i) => {
				this.#calibrateServerTimeDelta(perf, serverTimes[i]);
				isDown && this.#warnSizeMismatch(perf.transferSize, numBytes);
				return {
					perf,
					serverTime: serverTimes[i]
				};
			});
			const delta = this.#serverTimeDelta;
			const timing = aggregateBatchTiming(batch, {
				isDown,
				numBytes,
				estimatedServerTime: this.#estimatedServerTime,
				serverTimeDelta: delta
			});
			const serverTime = timing.serverTime > 0 ? timing.serverTime : this.#estimatedServerTime;
			if (+numBytes === 0) console.log("latency", {
				phase: `during ${requests[0].qsParams.during || "idle"}`,
				ttfb: timing.ttfb,
				serverTime,
				...delta && { serverTimeDelta: delta },
				ping: timing.ping
			});
			else console.log(isDown ? "download" : "upload", {
				bytes: numBytes * parallel,
				...parallel > 1 && { parallel },
				bps: timing.bps,
				ttfb: timing.ttfb,
				serverTime,
				...delta && { serverTimeDelta: delta },
				ping: timing.ping
			});
			const [perf] = perfs;
			this.#recordSample(measIdx, timing, parallel > 1 ? { parallel } : { perf: {
				startTime: perf.startTime,
				requestStart: perf.requestStart,
				responseStart: perf.responseStart,
				firstInterimResponseStart: perf.firstInterimResponseStart,
				finalResponseHeadersStart: perf.finalResponseHeadersStart,
				responseEnd: perf.responseEnd,
				nextHopProtocol: perf.nextHopProtocol,
				entries: entries[0].length
			} });
			this.#scheduleNextMeasurement();
		}).catch((error) => {
			if (!signal.aborted) this.#handleRequestError(error, requests[0].url);
		}).finally(() => setSignal.removeEventListener("abort", abortBatch));
	}
	#recordSample(measIdx, timing, debug) {
		const meas = this.#measurements[measIdx];
		const bytes = getSampleBytes(meas);
		if (!hasUsableSpeed(timing, bytes)) {
			console.warn(`Discarding ${meas.dir} sample without a speed`, {
				bytes,
				...timing,
				...debug
			});
			return false;
		}
		this.#saveMeasurementResults(measIdx, timing);
		this.#minDuration = this.#minDuration < 0 ? timing.duration : Math.min(this.#minDuration, timing.duration);
		return true;
	}
	#discardMissingEntry(dir, url) {
		console.warn(`Discarding ${dir} sample without a resource timing entry`, { url });
		if (++this.#missingEntries >= MAX_MISSING_ENTRIES) {
			this.pause();
			this.#onFatalError(`No resource timing entries for ${url}. The host page may be clearing or filling the buffer, or the runtime doesn't record resource timing.`);
			return;
		}
		this.#scheduleNextMeasurement();
	}
	#calibrateServerTimeDelta(perf, serverTime) {
		const connectTime = perf.secureConnectionStart > perf.connectStart ? perf.secureConnectionStart - perf.connectStart : perf.connectEnd - perf.connectStart;
		const protoMatch = perf.nextHopProtocol.match(/([0-9.]+)/);
		const httpVersion = protoMatch ? +protoMatch[1] : 0;
		if (!serverTime || !connectTime || httpVersion <= 0 || httpVersion >= 2) return;
		const delta = Math.max(0, getTtfb(perf) - connectTime) - serverTime;
		if (delta > 0 && delta <= SERVER_TIME_DELTA_MAX && delta <= serverTime && serverTime <= SERVER_TIME_CALIBRATION_MAX) {
			this.#serverTimeDelta = this.#serverTimeDelta * .25 + delta * SERVER_TIME_DELTA_WEIGHT;
			console.log(`serverTimeDelta (estimated): ${this.#serverTimeDelta.toFixed(2)}ms`);
		} else if (delta > 0) console.log(`serverTimeDelta (skipped): ${delta.toFixed(2)}ms`);
	}
	#warnSizeMismatch(transferSize, numBytes) {
		if (numBytes && transferSize && (transferSize < numBytes || transferSize / numBytes > 1.05)) console.warn(`Requested ${numBytes}B but received ${transferSize}B (${Math.round(transferSize / numBytes * 1e4) / 100}%).`);
	}
	#nextApiUrl(dir) {
		const apis = this.#apis[dir];
		const url = apis[this.#apiIdx[dir] % apis.length];
		this.#apiIdx[dir] += 1;
		return url;
	}
	#buildRequest(dir, numBytes, extraParams = {}) {
		const qsParams = {
			...this.#qsParams,
			...extraParams,
			bytes: `${numBytes}`
		};
		const urlObj = new URL(this.#nextApiUrl(dir), window.location.origin);
		Object.entries(qsParams).forEach(([k, v]) => urlObj.searchParams.set(k, v));
		const url = urlObj.href;
		return {
			url,
			qsParams,
			fetchOpt: withAuthorizationHeader(Object.assign({}, dir === "down" ? {} : {
				method: "POST",
				body: genContent(numBytes)
			}, this.#fetchOptions), this.#authorization, url)
		};
	}
	#prepareAbortController(description) {
		if (this.#retries === 0 || !this.#currentAbortController || this.#currentAbortController.signal.aborted) {
			this.#currentAbortController?.abort("restarting engine");
			clearTimeout(this.#abortTimeout);
			const controller = this.#currentAbortController = new AbortController();
			if (this.abortRequestDuration) this.#abortTimeout = setTimeout(() => {
				const errorMessage = `${description} aborted. Request exceeded abortRequestDuration (${this.abortRequestDuration}ms)`;
				controller.abort(errorMessage);
				this.#skipFailedRequest(errorMessage);
			}, this.abortRequestDuration);
		}
		return this.#currentAbortController;
	}
	#handleRequestError(error, url) {
		console.warn(`Error fetching ${url}: ${error}`);
		if (error instanceof HttpError && error.status === 429 && this.#retries++ < MAX_RETRIES) {
			this.#retryTimeout = setTimeout(() => {
				this.#retryTimeout = void 0;
				if (this.#running) this.#nextMeasurement();
			}, getRetryDelay(error.retryAfter));
			return;
		}
		const status = error instanceof HttpError ? error.status : void 0;
		const message = status === 429 ? `Connection failed to ${url}. Gave up after ${MAX_RETRIES} retries.` : status === void 0 ? `Connection failed to ${url}.` : `Request failed with ${status}: ${url}`;
		this.#skipFailedRequest(message, status);
	}
	#skipFailedRequest(message, status) {
		clearTimeout(this.#retryTimeout);
		this.#retryTimeout = void 0;
		this.#retries = 0;
		this.#onConnectionError(message, status);
		this.#running && this.#scheduleNextMeasurement();
	}
	#scheduleNextMeasurement() {
		clearTimeout(this.#abortTimeout);
		this.#counter += 1;
		this.#retries = 0;
		if (this.#throttleMs) this.#throttleTimeout = setTimeout(() => {
			this.#throttleTimeout = void 0;
			if (this.#running) this.#nextMeasurement();
		}, this.#throttleMs);
		else this.#nextMeasurement();
	}
	#cancelCurrentMeasurement(reason) {
		this.#currentAbortController?.abort(reason || `aborted with no reason provided`);
	}
};
//#endregion
//#region src/engines/BandwidthEngine/ParallelLatency.ts
var BandwidthWithParallelLatencyEngine = class extends BandwidthMeasurementEngine {
	constructor(measurements, { measureParallelLatency = false, parallelLatencyThrottleMs = 100, downloadApiUrl, uploadApiUrl, estimatedServerTime = 0, serverTimeDelta = 0, authorization = null, ...ptProps } = {}) {
		super(measurements, {
			downloadApiUrl,
			uploadApiUrl,
			estimatedServerTime,
			serverTimeDelta,
			authorization,
			...ptProps
		});
		if (measureParallelLatency) {
			this.#latencyEngine = new BandwidthMeasurementEngine([{
				dir: "down",
				bytes: 0,
				count: Infinity,
				bypassMinDuration: true
			}], {
				downloadApiUrl,
				uploadApiUrl,
				estimatedServerTime,
				serverTimeDelta,
				authorization,
				throttleMs: parallelLatencyThrottleMs
			});
			this.#latencyEngine.qsParams = { during: `${measurements[0].dir}load` };
			super.onRunningChange = this.#setLatencyRunning;
		}
	}
	get latencyResults() {
		return this.#latencyEngine && this.#latencyEngine.results.down[0].timings;
	}
	set onParallelLatencyResult(f) {
		this.#latencyEngine && (this.#latencyEngine.onMeasurementResult = (res) => f(res));
	}
	set onParallelLatencyError(f) {
		this.#latencyEngine && (this.#latencyEngine.onConnectionError = f);
	}
	get fetchOptions() {
		return super.fetchOptions;
	}
	set fetchOptions(fetchOptions) {
		super.fetchOptions = fetchOptions;
		this.#latencyEngine && (this.#latencyEngine.fetchOptions = fetchOptions);
	}
	get abortRequestDuration() {
		return super.abortRequestDuration;
	}
	set abortRequestDuration(abortRequestDuration) {
		super.abortRequestDuration = abortRequestDuration;
		this.#latencyEngine && (this.#latencyEngine.abortRequestDuration = abortRequestDuration);
	}
	set onFatalError(onFatalError) {
		super.onFatalError = onFatalError;
		this.#latencyEngine && (this.#latencyEngine.onFatalError = (error) => {
			this.pause();
			onFatalError(error);
		});
	}
	set onRunningChange(onRunningChange) {
		super.onRunningChange = (running) => {
			this.#setLatencyRunning(running);
			onRunningChange(running);
		};
	}
	#latencyEngine;
	#latencyTimeout;
	#setLatencyRunning = (running) => {
		if (this.#latencyEngine) {
			if (!running) {
				clearTimeout(this.#latencyTimeout);
				this.#latencyEngine.pause();
			} else this.#latencyTimeout = setTimeout(() => this.#latencyEngine.play(), 20);
		}
	};
};
//#endregion
//#region src/engines/BandwidthEngine/LoggingBandwidthEngine.ts
var LoggingBandwidthEngine = class extends BandwidthWithParallelLatencyEngine {
	constructor(measurements, { measurementId, logApiUrl, sessionId, authorization, ...ptProps } = {}) {
		super(measurements, {
			...ptProps,
			authorization
		});
		this.#measurementId = measurementId;
		this.#logApiUrl = logApiUrl;
		this.#sessionId = sessionId;
		this.#authorization = authorization ?? null;
		super.qsParams = logApiUrl ? { measId: this.#measurementId } : {};
		super.responseHook = (r) => this.#loggingResponseHook(r);
		super.onMeasurementResult = (meas, _results, measurement) => this.#logMeasurement(meas, measurement);
	}
	set qsParams(qsParams) {
		super.qsParams = this.#logApiUrl ? {
			measId: this.#measurementId,
			...qsParams
		} : qsParams;
	}
	set responseHook(responseHook) {
		super.responseHook = (r) => {
			responseHook(r);
			this.#loggingResponseHook(r);
		};
	}
	set onMeasurementResult(onMeasurementResult) {
		super.onMeasurementResult = (meas, results, measurement) => {
			onMeasurementResult(meas, results);
			this.#logMeasurement(meas, measurement);
		};
	}
	#measurementId;
	#token;
	#requestTime;
	#logApiUrl;
	#sessionId;
	#authorization;
	#loggingResponseHook(r) {
		if (!this.#logApiUrl) return;
		this.#requestTime = +r.headers.get(`cf-meta-request-time`);
		this.#token = r.body.slice(-300).split("___").pop();
	}
	#logMeasurement(measData, measurement) {
		if (!this.#logApiUrl || getParallelism(measurement) > 1) return;
		const logData = {
			type: measData.type,
			bytes: measData.bytes,
			ping: Math.round(measData.ping),
			ttfb: Math.round(measData.ttfb),
			payloadDownloadTime: Math.round(measData.payloadDownloadTime),
			duration: Math.round(measData.duration),
			transferSize: Math.round(measData.transferSize),
			serverTime: Math.round(measData.serverTime),
			token: this.#token,
			requestTime: this.#requestTime,
			measId: this.#measurementId,
			sessionId: this.#sessionId
		};
		this.#token = null;
		this.#requestTime = null;
		fetch(this.#logApiUrl, withAuthorizationHeader({
			method: "POST",
			body: JSON.stringify(logData),
			...this.fetchOptions
		}, this.#authorization, this.#logApiUrl)).catch(() => {});
	}
};
//#endregion
//#region src/engines/LoadNetworkEngine/index.ts
var PromiseEngine = class {
	constructor(promiseFn) {
		if (!promiseFn) throw new Error(`Missing operation to perform`);
		this.#promiseFn = promiseFn;
		this.play();
	}
	pause() {
		this.#cancelCurrent();
		this.#setRunning(false);
	}
	stop() {
		this.pause();
	}
	play() {
		if (!this.#running) {
			this.#setRunning(true);
			this.#next();
		}
	}
	#running = false;
	#currentPromise = void 0;
	#promiseFn;
	#setRunning(running) {
		if (running !== this.#running) this.#running = running;
	}
	#next() {
		const curPromise = this.#currentPromise = this.#promiseFn().then(() => {
			!curPromise._cancel && this.#next();
		});
	}
	#cancelCurrent() {
		const curPromise = this.#currentPromise;
		curPromise && (curPromise._cancel = true);
	}
};
var LoadNetworkEngine = class {
	constructor({ download, upload, authorization = null } = {}) {
		if (!download && !upload) throw new Error("Missing at least one of download/upload config");
		[[download, "download"], [upload, "upload"]].filter((entry) => entry[0] !== null && entry[0] !== void 0).forEach(([cfg, type]) => {
			const { apiUrl, chunkSize } = cfg;
			if (!apiUrl) throw new Error(`Missing ${type} apiUrl argument`);
			if (!chunkSize) throw new Error(`Missing ${type} chunkSize argument`);
		});
		const getLoadEngine = ({ apiUrl, qsParams = {}, fetchOptions = {} }) => new PromiseEngine(() => {
			const fetchQsParams = Object.assign({}, qsParams, this.qsParams);
			const urlObj = new URL(apiUrl, window.location.origin);
			Object.entries(fetchQsParams).forEach(([k, v]) => urlObj.searchParams.set(k, v));
			const url = urlObj.href;
			const fetchOpt = Object.assign({}, fetchOptions, this.fetchOptions);
			return fetch(url, withAuthorizationHeader(fetchOpt, authorization, url)).then((r) => {
				if (r.ok) return r;
				throw Error(r.statusText);
			}).then((r) => r.text());
		});
		download && this.#engines.push(getLoadEngine({
			apiUrl: download.apiUrl,
			qsParams: { bytes: `${download.chunkSize}` }
		}));
		upload && this.#engines.push(getLoadEngine({
			apiUrl: upload.apiUrl,
			fetchOptions: {
				method: "POST",
				body: "0".repeat(upload.chunkSize)
			}
		}));
	}
	qsParams = {};
	fetchOptions = {};
	pause() {
		this.#engines.forEach((engine) => engine.pause());
	}
	stop() {
		this.pause();
	}
	play() {
		this.#engines.forEach((engine) => engine.play());
	}
	#engines = [];
};
//#endregion
//#region src/engines/PacketLossEngine/SelfWebRtcDataConnection.ts
var SelfWebRtcDataConnection = class {
	constructor({ iceServers = [], acceptIceCandidate = (candidate) => {
		let protocol = candidate.protocol || "";
		if (!protocol && candidate.candidate) {
			const sdpAttrs = candidate.candidate.split(" ");
			sdpAttrs.length >= 3 && (protocol = sdpAttrs[2]);
		}
		return protocol.toLowerCase() === "udp";
	}, dataChannelCfg = {
		ordered: false,
		maxRetransmits: 0
	}, ...rtcPeerConnectionCfg } = {}) {
		const sender = new RTCPeerConnection({
			iceServers,
			...rtcPeerConnectionCfg
		});
		const receiver = new RTCPeerConnection({
			iceServers,
			...rtcPeerConnectionCfg
		});
		const senderDc = sender.createDataChannel("channel", dataChannelCfg);
		senderDc.onopen = () => {
			this.#established = true;
			this.onOpen();
		};
		senderDc.onclose = () => this.close();
		receiver.ondatachannel = (e) => {
			const dc = e.channel;
			dc.onclose = () => this.close();
			dc.onmessage = (msg) => this.onMessageReceived(msg.data);
			this.#receiverDc = dc;
		};
		sender.onicecandidate = (e) => {
			e.candidate && acceptIceCandidate(e.candidate) && receiver.addIceCandidate(e.candidate);
		};
		receiver.onicecandidate = (e) => {
			e.candidate && acceptIceCandidate(e.candidate) && sender.addIceCandidate(e.candidate);
		};
		sender.createOffer().then((offer) => sender.setLocalDescription(offer)).then(() => receiver.setRemoteDescription(sender.localDescription)).then(() => receiver.createAnswer()).then((answer) => receiver.setLocalDescription(answer)).then(() => sender.setRemoteDescription(receiver.localDescription));
		this.#sender = sender;
		this.#receiver = receiver;
		this.#senderDc = senderDc;
	}
	onOpen = () => {};
	onClose = () => {};
	onMessageReceived = () => {};
	send(msg) {
		this.#senderDc.send(String(msg));
	}
	close() {
		this.#sender && this.#sender.close();
		this.#receiver && this.#receiver.close();
		this.#senderDc && this.#senderDc.close();
		this.#receiverDc && this.#receiverDc.close();
		this.#established && this.onClose();
		this.#established = false;
		return this;
	}
	#established = false;
	#sender;
	#receiver;
	#senderDc;
	#receiverDc;
};
//#endregion
//#region src/engines/PacketLossEngine/PacketLossEngine.ts
var PacketLossEngine = class {
	constructor({ turnServerUri, turnServerCredsApi, turnServerCredsApiParser = ({ username, credential, server }) => ({
		turnServerUser: username,
		turnServerPass: credential,
		turnServerUri: server
	}), turnServerCredsApiIncludeCredentials = false, turnServerUser, turnServerPass, authorization = null, numMsgs = 100, batchSize = 10, batchWaitTime = 10, responsesWaitTime = 5e3, connectionTimeout = 5e3 } = {}) {
		if (!turnServerUri && !turnServerCredsApi) throw new Error("No TURN server configured: set turnServerCredsApiUrl or turnServerUri");
		if ((!turnServerUser || !turnServerPass) && !turnServerCredsApi) throw new Error("No TURN credentials configured: set turnServerCredsApiUrl, or turnServerUser and turnServerPass");
		this.#numMsgs = numMsgs;
		(!turnServerUser || !turnServerPass ? fetch(turnServerCredsApi, withAuthorizationHeader(turnServerCredsApiIncludeCredentials ? { credentials: "include" } : {}, authorization, turnServerCredsApi)).then((r) => r.json()).then((d) => {
			if (d.error) throw d.error;
			return d;
		}).then(turnServerCredsApiParser) : Promise.resolve({
			turnServerUser,
			turnServerPass
		})).catch((e) => this.#onCredentialsFailure(e)).then((creds) => {
			if (!creds) return;
			const { turnServerUser: credsUser, turnServerPass: credsPass, turnServerUri: credsApiTurnServerUri } = creds;
			const uri = credsApiTurnServerUri || turnServerUri;
			if (!uri) {
				this.#onConnectionError("No TURN server URI: set turnServerUri or return server from the credentials API");
				return;
			}
			const c = new SelfWebRtcDataConnection({
				iceServers: [{
					urls: `turn:${uri}?transport=udp`,
					username: credsUser,
					credential: credsPass
				}],
				iceTransportPolicy: "relay"
			});
			let connectionSuccess = false;
			setTimeout(() => {
				if (!connectionSuccess) {
					c.close();
					this.#onConnectionError("ICE connection timeout!");
				}
			}, connectionTimeout);
			const msgTracker = this.#msgTracker;
			c.onOpen = () => {
				connectionSuccess = true;
				const self = this;
				(function sendNum(n) {
					if (n <= numMsgs) {
						let i = n;
						while (i <= Math.min(numMsgs, n + batchSize - 1)) {
							msgTracker[i] = false;
							c.send(i);
							self.onMsgSent(i);
							i++;
						}
						setTimeout(() => sendNum(i), batchWaitTime);
					} else {
						self.onAllMsgsSent(Object.keys(msgTracker).length);
						const finishFn = () => {
							c.close();
							self.#onFinished(self.results);
						};
						let finishTimeout = setTimeout(finishFn, responsesWaitTime);
						let missingMsgs = Object.values(self.#msgTracker).filter((recv) => !recv).length;
						c.onMessageReceived = (msg) => {
							clearTimeout(finishTimeout);
							msgTracker[msg] = true;
							self.onMsgReceived(msg);
							missingMsgs--;
							if (missingMsgs <= 0 && Object.values(self.#msgTracker).every((recv) => recv)) finishFn();
							else finishTimeout = setTimeout(finishFn, responsesWaitTime);
						};
					}
				})(1);
			};
			c.onMessageReceived = (msg) => {
				msgTracker[msg] = true;
				this.onMsgReceived(msg);
			};
		}).catch((e) => this.#onConnectionError(e.toString()));
	}
	#onCredentialsFailure = () => {};
	set onCredentialsFailure(f) {
		this.#onCredentialsFailure = f;
	}
	#onConnectionError = () => {};
	set onConnectionError(f) {
		this.#onConnectionError = f;
	}
	#onFinished = () => {};
	set onFinished(f) {
		this.#onFinished = f;
	}
	onMsgSent = () => {};
	onAllMsgsSent = () => {};
	onMsgReceived = () => {};
	get results() {
		const totalMessages = this.#numMsgs;
		const numMessagesSent = Object.keys(this.#msgTracker).length;
		const lostMessages = Object.entries(this.#msgTracker).filter(([, recv]) => !recv).map(([n]) => +n);
		return {
			totalMessages,
			numMessagesSent,
			packetLoss: lostMessages.length / numMessagesSent,
			lostMessages
		};
	}
	#msgTracker = {};
	#numMsgs;
};
//#endregion
//#region src/engines/PacketLossEngine/UnderLoad.ts
var PacketLossUnderLoadEngine = class extends PacketLossEngine {
	constructor({ downloadChunkSize, uploadChunkSize, downloadApiUrl, uploadApiUrl, authorization, ...ptProps } = {}) {
		super({
			...ptProps,
			authorization
		});
		if (downloadChunkSize || uploadChunkSize) {
			this.#loadEngine = new LoadNetworkEngine({
				download: downloadChunkSize ? {
					apiUrl: downloadApiUrl,
					chunkSize: downloadChunkSize
				} : null,
				upload: uploadChunkSize ? {
					apiUrl: uploadApiUrl,
					chunkSize: uploadChunkSize
				} : null,
				authorization
			});
			super.onCredentialsFailure = super.onConnectionError = super.onFinished = () => this.#loadEngine.stop();
		}
	}
	set qsParams(qsParams) {
		this.#loadEngine && (this.#loadEngine.qsParams = qsParams);
	}
	set fetchOptions(fetchOptions) {
		this.#loadEngine && (this.#loadEngine.fetchOptions = fetchOptions);
	}
	set onCredentialsFailure(onCredentialsFailure) {
		super.onCredentialsFailure = (...args) => {
			onCredentialsFailure(...args);
			this.#loadEngine && this.#loadEngine.stop();
		};
	}
	set onConnectionError(onConnectionError) {
		super.onConnectionError = (...args) => {
			onConnectionError(...args);
			this.#loadEngine && this.#loadEngine.stop();
		};
	}
	set onFinished(onFinished) {
		super.onFinished = (...args) => {
			onFinished(...args);
			this.#loadEngine && this.#loadEngine.stop();
		};
	}
	#loadEngine;
};
//#endregion
//#region src/engines/ReachabilityEngine/index.ts
var ReachabilityEngine = class {
	constructor(targetUrl, { timeout = -1, fetchOptions = {} } = {}) {
		let finished = false;
		const finish = ({ reachable, ...rest }) => {
			if (finished) return;
			finished = true;
			this.onFinished({
				targetUrl,
				reachable,
				...rest
			});
		};
		fetch(targetUrl, fetchOptions).then((response) => {
			finish({
				reachable: true,
				response
			});
		}).catch((error) => {
			finish({
				reachable: false,
				error
			});
		});
		timeout > 0 && setTimeout(() => finish({
			reachable: false,
			error: "Request timeout"
		}), timeout);
	}
	onFinished = () => {};
};
//#endregion
//#region src/utils/numbers.ts
const sum = (vals) => vals.reduce((agg, val) => agg + val, 0);
const percentile = (vals, perc = .5) => {
	if (!vals.length) return 0;
	const sortedVals = vals.slice().sort((a, b) => a - b);
	const idx = (vals.length - 1) * perc;
	const rem = idx % 1;
	if (rem === 0) return sortedVals[Math.round(idx)];
	const edges = [Math.floor, Math.ceil].map((rndFn) => sortedVals[rndFn(idx)]);
	return edges[0] + (edges[1] - edges[0]) * rem;
};
//#endregion
//#region src/Results/MeasurementCalculations.ts
var MeasurementCalculations = class {
	constructor(config) {
		this.#config = config;
	}
	getLatencyPoints = (latencyResults) => latencyResults.timings.map((d) => d.ping);
	getLatency = (latencyResults) => percentile(this.getLatencyPoints(latencyResults), this.#config.latencyPercentile);
	getJitter(latencyResults) {
		const pings = this.getLatencyPoints(latencyResults);
		return pings.length < 2 ? null : pings.reduce(({ sumDeltas = 0, prevLatency }, latency) => ({
			sumDeltas: sumDeltas + (prevLatency !== void 0 ? Math.abs(prevLatency - latency) : 0),
			prevLatency: latency
		}), {}).sumDeltas / (pings.length - 1);
	}
	getBandwidthPoints = (bandwidthResults, parallelResults) => this.#getBuckets(bandwidthResults, parallelResults).flatMap(({ bytes, parallel, bucket }) => bucket.timings.map(({ bps, duration, ping, measTime, serverTime, transferSize }) => ({
		bytes,
		bps,
		duration,
		ping,
		measTime,
		serverTime,
		transferSize,
		...parallel && { parallel }
	})));
	getBandwidth = (bandwidthResults, parallelResults) => percentile(this.getBandwidthPoints(bandwidthResults, parallelResults).filter((d) => d.duration >= this.#config.bandwidthMinRequestDuration).map((d) => d.bps).filter((bps) => bps), this.#config.bandwidthPercentile);
	getLoadedLatency = (loadedResults, parallelResults) => this.getLatency({ timings: this.#extractLoadedLatencies(loadedResults, parallelResults) });
	getLoadedJitter = (loadedResults, parallelResults) => this.getJitter({ timings: this.#extractLoadedLatencies(loadedResults, parallelResults) });
	getLoadedLatencyPoints = (loadedResults, parallelResults) => this.getLatencyPoints({ timings: this.#extractLoadedLatencies(loadedResults, parallelResults) });
	getPacketLoss = (plResults) => plResults.packetLoss;
	getPacketLossDetails = (plResults) => plResults;
	getReachability = (reachabilityResults) => !!reachabilityResults.reachable;
	getReachabilityDetails = (d) => ({
		host: d.host,
		reachable: d.reachable
	});
	#config;
	#getBuckets = (results, parallelResults = {}) => [...Object.entries(results).map(([bytes, bucket]) => ({
		bytes: +bytes,
		parallel: void 0,
		bucket
	})), ...Object.values(parallelResults).flatMap((byBytes) => Object.values(byBytes)).map((bucket) => ({
		bytes: bucket.bytes,
		parallel: bucket.parallel,
		bucket
	}))].sort((a, b) => a.bytes - b.bytes);
	#extractLoadedLatencies = (loadedResults, parallelResults) => this.#getBuckets(loadedResults, parallelResults).map(({ bucket }) => bucket).filter((d) => d.timings.length && Math.min(...d.timings.map((d) => d.duration)) >= this.#config.loadedRequestMinDuration).map((d) => d.sideLatency || []).flat().slice(-this.#config.loadedLatencyMaxPoints);
};
//#endregion
//#region src/Results/ScoresCalculations.ts
const classificationNames = [
	"bad",
	"poor",
	"average",
	"good",
	"great"
];
const customResultTypes = { loadedLatencyIncrease: (measurements) => measurements.latency && (measurements.downLoadedLatency || measurements.upLoadedLatency) ? Math.max(measurements.downLoadedLatency, measurements.upLoadedLatency) - measurements.latency : void 0 };
const defaultPoints = { packetLoss: 0 };
var ScoresCalculations = class {
	constructor(config) {
		this.#config = config;
	}
	getScores(measurements, omit = []) {
		const scores = Object.assign({}, ...Object.entries(this.#config.aimMeasurementScoring).map(([type, fn]) => {
			const val = customResultTypes.hasOwnProperty(type) ? customResultTypes[type](measurements) : measurements[type];
			return val === void 0 ? defaultPoints.hasOwnProperty(type) ? { [type]: defaultPoints[type] } : {} : { [type]: +fn(val) };
		}));
		return Object.assign({}, ...Object.entries(this.#config.aimExperiencesDefs).map(([k, { input, pointThresholds }]) => [k, {
			input: input.filter((m) => !omit.includes(m)),
			pointThresholds
		}]).filter(([, { input }]) => input.every((k) => scores.hasOwnProperty(k))).map(([k, { input, pointThresholds }]) => {
			const sumPoints = Math.max(0, sum(input.map((k) => scores[k])));
			const classificationIdx = scaleThreshold(pointThresholds, [
				0,
				1,
				2,
				3,
				4
			])(sumPoints);
			const classificationName = classificationNames[classificationIdx];
			return { [k]: {
				points: sumPoints,
				classificationIdx,
				classificationName
			} };
		}));
	}
	#config;
};
//#endregion
//#region src/Results/index.ts
var Results = class {
	constructor(config) {
		this.#config = config;
		this.clear();
		this.#measCalc = new MeasurementCalculations(this.#config);
		this.#scoresCalc = new ScoresCalculations(this.#config);
	}
	raw;
	get isFinished() {
		return Object.values(this.raw).filter((d) => d !== null && typeof d === "object").every((d) => d.finished);
	}
	clear() {
		this.raw = Object.assign({ totalDurationMs: void 0 }, ...[...new Set(this.#config.measurements.map((m) => m.type))].map((m) => ({ [m]: {
			started: false,
			finished: false,
			results: {}
		} })));
	}
	getUnloadedLatency = () => this.#calcGetter("getLatency", "latency");
	getUnloadedJitter = () => this.#calcGetter("getJitter", "latency");
	getUnloadedLatencyPoints = () => this.#calcGetter("getLatencyPoints", "latency", []);
	getDownLoadedLatency = () => this.#calcGetter("getLoadedLatency", "download");
	getDownLoadedJitter = () => this.#calcGetter("getLoadedJitter", "download");
	getDownLoadedLatencyPoints = () => this.#calcGetter("getLoadedLatencyPoints", "download", []);
	getUpLoadedLatency = () => this.#calcGetter("getLoadedLatency", "upload");
	getUpLoadedJitter = () => this.#calcGetter("getLoadedJitter", "upload");
	getUpLoadedLatencyPoints = () => this.#calcGetter("getLoadedLatencyPoints", "upload", []);
	getDownloadBandwidth = () => this.#calcGetter("getBandwidth", "download");
	getDownloadBandwidthPoints = () => this.#calcGetter("getBandwidthPoints", "download", []);
	getUploadBandwidth = () => this.#calcGetter("getBandwidth", "upload");
	getUploadBandwidthPoints = () => this.#calcGetter("getBandwidthPoints", "upload", []);
	getPacketLoss = () => this.#calcGetter("getPacketLoss", "packetLoss");
	getPacketLossDetails = () => this.#calcGetter("getPacketLossDetails", "packetLoss", void 0, true);
	getTotalDurationMs = () => this.raw.totalDurationMs;
	getSummary() {
		const items = {
			download: this.getDownloadBandwidth,
			upload: this.getUploadBandwidth,
			latency: this.getUnloadedLatency,
			jitter: this.getUnloadedJitter,
			downLoadedLatency: this.getDownLoadedLatency,
			downLoadedJitter: this.getDownLoadedJitter,
			upLoadedLatency: this.getUpLoadedLatency,
			upLoadedJitter: this.getUpLoadedJitter,
			packetLoss: this.getPacketLoss,
			v4Reachability: this.#getV4Reachability,
			v6Reachability: this.#getV6Reachability,
			totalDurationMs: this.getTotalDurationMs
		};
		return Object.assign({}, ...Object.entries(items).map(([key, fn]) => {
			const val = fn();
			return val === void 0 ? {} : { [key]: val };
		}));
	}
	getScores = () => this.#scoresCalc.getScores(this.getSummary(), this.raw.packetLoss ? [] : ["packetLoss"]);
	#config;
	#measCalc;
	#scoresCalc;
	#calcGetter = (calcFn, resKey, defaultVal = void 0, surfaceError = false) => {
		const entry = this.raw[resKey];
		if (!entry || typeof entry !== "object" || !entry.started) return defaultVal;
		const measEntry = entry;
		if (surfaceError && measEntry.error) return { error: measEntry.error };
		return this.#measCalc[calcFn](measEntry.results, measEntry.parallelResults);
	};
	#getV4Reachability = () => this.#calcGetter("getReachability", "v4Reachability");
	#getV4ReachabilityDetails = () => this.#calcGetter("getReachabilityDetails", "v4Reachability");
	#getV6Reachability = () => this.#calcGetter("getReachability", "v6Reachability");
	#getV6ReachabilityDetails = () => this.#calcGetter("getReachabilityDetails", "v6Reachability");
};
//#endregion
//#region src/logging/logFinalResults.ts
const round = (num, decimals = 0) => !num ? num : Math.round(num * 10 ** decimals) / 10 ** decimals;
const latencyPointsParser = (durations) => durations.map((d) => round(d, 2));
const bpsPointsParser = (pnts) => pnts.map((d) => ({
	bytes: +d.bytes,
	bps: round(d.bps)
}));
const packetLossParser = (d) => {
	const details = d;
	return details.error ? void 0 : {
		numMessages: details.numMessagesSent,
		lossRatio: round(details.packetLoss, 4)
	};
};
const resultsParsers = {
	latencyMs: ["getUnloadedLatencyPoints", latencyPointsParser],
	download: ["getDownloadBandwidthPoints", bpsPointsParser],
	upload: ["getUploadBandwidthPoints", bpsPointsParser],
	downLoadedLatencyMs: ["getDownLoadedLatencyPoints", latencyPointsParser],
	upLoadedLatencyMs: ["getUpLoadedLatencyPoints", latencyPointsParser],
	packetLoss: ["getPacketLossDetails", packetLossParser],
	totalDurationMs: ["getTotalDurationMs"]
};
const scoreParser = (d) => ({
	points: d.points,
	classification: d.classificationName
});
const logAimResults = async (results, { apiUrl, includeCredentials, sessionId, authorization }) => {
	const logData = { sessionId };
	Object.entries(resultsParsers).forEach(([logK, [fn, parser]]) => {
		const resolvedParser = parser ?? ((d) => d);
		const val = results[fn]();
		if (val) logData[logK] = resolvedParser(val);
	});
	const scores = results.getScores();
	if (scores) logData.scores = Object.assign({}, ...Object.entries(scores).map(([k, score]) => ({ [k]: scoreParser(score) })));
	console.log("results", logData);
	try {
		const response = await fetch(apiUrl, withAuthorizationHeader({
			method: "POST",
			body: JSON.stringify(logData),
			credentials: includeCredentials ? "include" : "same-origin"
		}, authorization, apiUrl));
		if (!response.ok) return { requestId: void 0 };
		return await response.json();
	} catch {
		return { requestId: void 0 };
	}
};
//#endregion
//#region src/utils/measurementTargets.ts
const parseOrigin = (target) => {
	let url;
	try {
		url = typeof target === "string" ? new URL(target) : void 0;
	} catch {}
	if (!url || !/^https?:$/.test(url.protocol) || url.pathname !== "/" || url.search || url.hash) throw new TypeError(`Invalid measurementTargets entry "${target}": expected an origin such as https://speed.cloudflare.com`);
	return url.origin;
};
const resolveApiUrls = (targets, { path, option }, fallbackUrl) => {
	if (!Array.isArray(targets)) throw new TypeError(`Invalid measurementTargets: expected an array of origins, got ${typeof targets}`);
	if (typeof path !== "string") throw new TypeError(`Invalid ${option}: expected a path starting with /, got ${typeof path}`);
	const resolve = (origin) => {
		let url;
		try {
			url = path.startsWith("/") ? new URL(path, origin) : void 0;
		} catch {}
		if (!url || url.origin !== origin) throw new TypeError(`Invalid ${option} "${path}": expected a path starting with /`);
		return url.href;
	};
	resolve("https://placeholder.invalid");
	return targets.length ? targets.map((target) => resolve(parseOrigin(target))) : [fallbackUrl];
};
//#endregion
//#region src/index.ts
const DEFAULT_OPTIMAL_DOWNLOAD_SIZE = 1e6;
const DEFAULT_OPTIMAL_UPLOAD_SIZE = 1e6;
const OPTIMAL_SIZE_RATIO = .5;
const pausableTypes = [
	"latency",
	"latencyUnderLoad",
	"download",
	"upload"
];
const genMeasId = () => `${Math.round(Math.random() * 0x2386f26fc10000)}`;
var MeasurementEngine = class {
	constructor(userConfig = {}) {
		const { bandwidthAbortRequestDuration, ...options } = userConfig;
		this.#config = Object.assign({}, defaultConfig, options, internalConfig);
		this.#config.abortRequestDuration = options.abortRequestDuration ?? bandwidthAbortRequestDuration ?? defaultConfig.abortRequestDuration;
		this.#config.measurementTargets ??= defaultConfig.measurementTargets;
		this.#config.measurementDownloadPath ??= defaultConfig.measurementDownloadPath;
		this.#config.measurementUploadPath ??= defaultConfig.measurementUploadPath;
		this.#authorization = {
			token: this.#config.authorizationToken,
			enabled: this.#config.authorizationEnabled,
			allowInsecure: this.#config.allowInsecureAuthorizationToken
		};
		this.#downloadApiUrls = resolveApiUrls(this.#config.measurementTargets, {
			path: this.#config.measurementDownloadPath,
			option: "measurementDownloadPath"
		}, this.#config.downloadApiUrl);
		this.#uploadApiUrls = resolveApiUrls(this.#config.measurementTargets, {
			path: this.#config.measurementUploadPath,
			option: "measurementUploadPath"
		}, this.#config.uploadApiUrl);
		this.#results = new Results(this.#config);
		this.#config.autoStart && this.play();
	}
	get results() {
		return this.#results;
	}
	get config() {
		return this.#config;
	}
	get authorization() {
		return this.#authorization;
	}
	get isRunning() {
		return this.#running;
	}
	get isFinished() {
		return this.#finished;
	}
	onRunningChange = () => {};
	onResultsChange = () => {};
	onPhaseChange = () => {};
	#onFinish = () => {};
	set onFinish(f) {
		this.#onFinish = f;
	}
	#onError = () => {};
	set onError(f) {
		this.#onError = f;
	}
	pause() {
		const curType = this.#curType();
		curType && pausableTypes.includes(curType) && this.#curEngine?.pause?.();
		this.#setRunning(false);
	}
	play() {
		if (!this.#running) {
			performance.clearResourceTimings();
			performance.setResourceTimingBufferSize(1e4);
			this.#setRunning(true);
			this.#next();
		}
	}
	restart() {
		this.#clear();
		this.play();
	}
	#config;
	#authorization;
	#results;
	#measurementId = genMeasId();
	#serverTimeDelta = 0;
	#curMsmIdx = -1;
	#curEngine;
	#optimalDownloadChunkSize = DEFAULT_OPTIMAL_DOWNLOAD_SIZE;
	#optimalUploadChunkSize = DEFAULT_OPTIMAL_UPLOAD_SIZE;
	#downloadApiUrls;
	#uploadApiUrls;
	#startTime;
	#accumulatedRuntimeMs = 0;
	#abortTestTimeout;
	#running = false;
	#finished = false;
	#skipLog = false;
	#setRunning(running) {
		if (running !== this.#running) {
			this.#running = running;
			this.onRunningChange(this.#running);
		}
		if (running) this.#startTime = performance.now();
		else if (typeof this.#startTime !== "undefined") {
			this.#accumulatedRuntimeMs += performance.now() - this.#startTime;
			this.#startTime = void 0;
		}
		this.#scheduleAbortTest();
	}
	#scheduleAbortTest() {
		clearTimeout(this.#abortTestTimeout);
		this.#abortTestTimeout = void 0;
		const limit = this.#config.abortTestDuration;
		if (!(limit > 0) || !this.#running || this.#finished) return;
		this.#abortTestTimeout = setTimeout(() => this.#endTest(`Test aborted. Test exceeded abortTestDuration (${this.#config.abortTestDuration}ms)`), Math.max(0, limit - this.#accumulatedRuntimeMs));
	}
	#reportErrorAndContinue(...error) {
		const measurementId = this.#measurementId;
		this.#onError(...error);
		if (measurementId !== this.#measurementId) return;
		this.#running && this.#next();
	}
	#endTest(message, { skipLog = false } = {}) {
		const type = this.#curType();
		const msmResults = this.#curTypeResults();
		this.#destroyCurEngine();
		this.#curMsmIdx = this.#config.measurements.length;
		this.#results.raw.error = message;
		if (type && msmResults) {
			msmResults.error = message;
			this.onResultsChange({ type });
		}
		this.#skipLog = skipLog;
		const measurementId = this.#measurementId;
		this.#onError(message);
		if (measurementId !== this.#measurementId) return;
		this.#setRunning(false);
		this.#setFinished(true);
	}
	#setFinished(finished) {
		if (finished !== this.#finished) {
			this.#finished = finished;
			if (finished) {
				this.#results.raw.totalDurationMs = this.#accumulatedRuntimeMs;
				const skipLog = this.#skipLog;
				setTimeout(() => this.#onFinish(this.results, { skipLog }));
			}
		}
	}
	#curType() {
		return this.#curMsmIdx < 0 || this.#curMsmIdx >= this.#config.measurements.length ? null : this.#config.measurements[this.#curMsmIdx].type;
	}
	#curTypeResults() {
		const type = this.#curType();
		if (!type) return void 0;
		return this.#results.raw[type] || void 0;
	}
	#clear() {
		this.#destroyCurEngine();
		this.#measurementId = genMeasId();
		this.#curMsmIdx = -1;
		this.#curEngine = void 0;
		this.#setRunning(false);
		this.#setFinished(false);
		this.#skipLog = false;
		this.#results.clear();
		this.#accumulatedRuntimeMs = 0;
	}
	#destroyCurEngine() {
		const engine = this.#curEngine;
		if (!engine) return;
		engine.onFinished = engine.onConnectionError = engine.onMsgReceived = engine.onCredentialsFailure = engine.onMeasurementResult = engine.onNewMeasurementStarted = engine.onParallelLatencyResult = engine.onParallelLatencyError = engine.onFatalError = () => {};
		const curType = this.#curType();
		curType && pausableTypes.includes(curType) && engine.pause?.();
	}
	#next() {
		const resumeType = this.#curType();
		const resumeResults = this.#curTypeResults();
		if (resumeType && pausableTypes.includes(resumeType) && resumeResults && resumeResults.started && !resumeResults.finished && !resumeResults.finishedCurrentRound) {
			this.#curEngine?.play?.();
			return;
		}
		this.#curMsmIdx++;
		if (this.#curMsmIdx >= this.#config.measurements.length) {
			this.#setRunning(false);
			this.#setFinished(true);
			return;
		}
		const { type, ...msmConfig } = this.#config.measurements[this.#curMsmIdx];
		const msmResults = this.#curTypeResults();
		this.onPhaseChange({
			measurementId: this.#curMsmIdx,
			measurement: {
				type,
				...msmConfig
			}
		});
		const { estimatedServerTime } = this.#config;
		const downloadApiUrl = this.#downloadApiUrls;
		const uploadApiUrl = this.#uploadApiUrls;
		let engine;
		switch (type) {
			case "v4Reachability":
			case "v6Reachability":
				engine = new ReachabilityEngine(`https://${msmConfig.host}`, { fetchOptions: {
					method: "GET",
					mode: "no-cors"
				} });
				engine.onFinished = (result) => {
					const r = result;
					msmResults.finished = true;
					msmResults.results = {
						host: msmConfig.host,
						...r
					};
					this.onResultsChange({ type });
					this.#next();
				};
				break;
			case "rpki":
				engine = new ReachabilityEngine(`https://${this.#config.rpkiInvalidHost}`, { timeout: 5e3 });
				engine.onFinished = (result) => {
					const r = result;
					(r.response ? r.response.json() : Promise.resolve()).then((response) => {
						msmResults.finished = true;
						msmResults.results = {
							host: this.#config.rpkiInvalidHost,
							filteringInvalids: !r.reachable,
							...response ? {
								asn: response.asn,
								name: response.name
							} : {}
						};
						this.onResultsChange({ type });
						this.#next();
					});
				};
				break;
			case "nxdomain":
				engine = new ReachabilityEngine(`https://${msmConfig.nxhost}`, { fetchOptions: { mode: "no-cors" } });
				engine.onFinished = (result) => {
					const r = result;
					msmResults.finished = true;
					msmResults.results = {
						host: msmConfig.nxhost,
						reachable: r.reachable
					};
					this.onResultsChange({ type });
					this.#next();
				};
				break;
			case "packetLoss":
			case "packetLossUnderLoad":
				{
					msmResults.finished = false;
					const { numPackets: numMsgs, ...ptCfg } = msmConfig;
					const { turnServerUri, turnServerCredsApiUrl: turnServerCredsApi, turnServerUser, turnServerPass, includeCredentials } = this.#config;
					try {
						engine = new PacketLossUnderLoadEngine({
							turnServerUri: turnServerUri ?? void 0,
							turnServerCredsApi: turnServerCredsApi ?? void 0,
							turnServerCredsApiIncludeCredentials: includeCredentials,
							turnServerUser: turnServerUser ?? void 0,
							turnServerPass: turnServerPass ?? void 0,
							authorization: this.authorization,
							numMsgs,
							downloadChunkSize: msmConfig.loadDown ? this.#optimalDownloadChunkSize : void 0,
							uploadChunkSize: msmConfig.loadUp ? this.#optimalUploadChunkSize : void 0,
							downloadApiUrl: downloadApiUrl[0],
							uploadApiUrl: uploadApiUrl[0],
							...ptCfg
						});
					} catch (e) {
						const message = e instanceof Error ? e.message : String(e);
						const measurementId = this.#measurementId;
						queueMicrotask(() => {
							if (measurementId !== this.#measurementId) return;
							msmResults.started = true;
							msmResults.finished = true;
							msmResults.error = message;
							this.onResultsChange({ type });
							this.#reportErrorAndContinue(`Error while measuring packet loss: ${message}`);
						});
						return;
					}
				}
				engine.onMsgReceived = () => {
					msmResults.results = Object.assign({}, engine.results);
					this.onResultsChange({ type });
				};
				engine.onFinished = () => {
					msmResults.finished = true;
					this.onResultsChange({ type });
					this.#running && this.#next();
				};
				engine.onConnectionError = (e) => {
					msmResults.finished = true;
					msmResults.error = e;
					this.onResultsChange({ type });
					this.#reportErrorAndContinue(`Connection error while measuring packet loss: ${e}`);
				};
				engine.onCredentialsFailure = () => {
					msmResults.finished = true;
					msmResults.error = "unable to get turn server credentials";
					this.onResultsChange({ type });
					this.#reportErrorAndContinue("Error while measuring packet loss: unable to get turn server credentials.");
				};
				break;
			case "latency":
			case "latencyUnderLoad": {
				msmResults.finished = false;
				engine = new LoggingBandwidthEngine([{
					dir: "down",
					bytes: 0,
					count: msmConfig.numPackets,
					bypassMinDuration: true
				}], {
					downloadApiUrl,
					uploadApiUrl,
					estimatedServerTime,
					serverTimeDelta: this.#serverTimeDelta,
					logApiUrl: this.#config.logMeasurementApiUrl ?? void 0,
					measurementId: this.#measurementId,
					sessionId: this.#config.sessionId,
					authorization: this.authorization,
					downloadChunkSize: msmConfig.loadDown ? this.#optimalDownloadChunkSize : void 0,
					uploadChunkSize: msmConfig.loadUp ? this.#optimalUploadChunkSize : void 0
				});
				engine.fetchOptions = this.#config.includeCredentials ? { credentials: "include" } : {};
				engine.abortRequestDuration = this.#config.abortRequestDuration;
				if (!msmConfig.loadDown && !msmConfig.loadUp) {
					const eng = engine;
					eng.qsParams = {
						...eng.qsParams,
						during: "idle"
					};
				}
				const priorTimings = (msmResults.results?.timings || []).slice();
				engine.onMeasurementResult = engine.onNewMeasurementStarted = (_meas, results) => {
					msmResults.results = Object.assign({}, results.down[0]);
					msmResults.results.timings = priorTimings.concat(msmResults.results.timings);
					this.onResultsChange({ type });
				};
				engine.onFinished = () => {
					this.#serverTimeDelta = engine.serverTimeDelta;
					msmResults.finished = true;
					this.onResultsChange({ type });
					this.#running && this.#next();
				};
				engine.onConnectionError = (e, status) => this.#onError(`Connection error while measuring latency: ${e}`, status);
				engine.onFatalError = (e) => this.#endTest(`Connection error while measuring latency: ${e}`, { skipLog: true });
				engine.play();
				break;
			}
			case "download":
			case "upload": if (msmResults.finished) {
				this.#next();
				return;
			} else {
				delete msmResults.finishedCurrentRound;
				const measureParallelLatency = this.#config[`measure${type === "download" ? "Down" : "Up"}loadLoadedLatency`];
				engine = new LoggingBandwidthEngine([{
					dir: type === "download" ? "down" : "up",
					...msmConfig
				}], {
					downloadApiUrl,
					uploadApiUrl,
					estimatedServerTime,
					serverTimeDelta: this.#serverTimeDelta,
					logApiUrl: this.#config.logMeasurementApiUrl ?? void 0,
					measurementId: this.#measurementId,
					measureParallelLatency,
					parallelLatencyThrottleMs: this.#config.loadedLatencyThrottle,
					sessionId: this.#config.sessionId,
					authorization: this.authorization
				});
				engine.fetchOptions = this.#config.includeCredentials ? { credentials: "include" } : {};
				engine.finishRequestDuration = this.#config.bandwidthFinishRequestDuration;
				engine.abortRequestDuration = this.#config.abortRequestDuration;
				const requestBytes = msmConfig.bytes;
				const parallel = getParallelism({ parallel: msmConfig.parallel });
				const getBucket = () => {
					const newBucket = {
						timings: [],
						numMeasurements: 0,
						sideLatency: measureParallelLatency ? [] : void 0
					};
					if (parallel === 1) {
						const res = msmResults.results = { ...msmResults.results };
						return res[requestBytes] ??= newBucket;
					}
					const all = msmResults.parallelResults = { ...msmResults.parallelResults };
					const byBytes = all[parallel] = { ...all[parallel] };
					return byBytes[requestBytes] ??= {
						bytes: requestBytes * parallel,
						parallel,
						...newBucket
					};
				};
				engine.onNewMeasurementStarted = (...args) => {
					const { count } = args[0];
					const bucket = getBucket();
					if (bucket.numMeasurements - bucket.timings.length !== count) {
						bucket.numMeasurements += count;
						this.onResultsChange({ type });
					}
				};
				engine.onMeasurementResult = (...args) => {
					const timing = { ...args[0] };
					delete timing.bytes;
					getBucket().timings.push(timing);
					this.onResultsChange({ type });
				};
				engine.onParallelLatencyResult = (res) => {
					getBucket().sideLatency.push(res);
					this.onResultsChange({ type });
				};
				engine.onFinished = (results) => {
					this.#serverTimeDelta = engine.serverTimeDelta;
					const bwResults = results;
					const isLastMsmOfType = !this.#config.measurements.slice(this.#curMsmIdx + 1).map((d) => d.type).includes(type);
					const durations = Object.values(type === "download" ? bwResults.down : bwResults.up).slice(-1)[0].timings.map((d) => d.duration);
					if (!(isLastMsmOfType || !msmConfig.bypassMinDuration && durations.length > 0 && Math.min(...durations) > this.#config.bandwidthFinishRequestDuration)) msmResults.finishedCurrentRound = true;
					else {
						msmResults.finished = true;
						this.onResultsChange({ type });
						const ran = ({ bytes, parallel }) => {
							const n = getParallelism({ parallel });
							return Object.hasOwn((n === 1 ? msmResults.results : msmResults.parallelResults?.[n]) ?? {}, bytes);
						};
						const optimalSize = Math.max(...this.#config.measurements.slice(0, this.#curMsmIdx + 1).filter((m) => m.type === type && ran(m)).map((m) => m.bytes)) * OPTIMAL_SIZE_RATIO;
						type === "download" && (this.#optimalDownloadChunkSize = optimalSize);
						type === "upload" && (this.#optimalUploadChunkSize = optimalSize);
					}
					this.#running && this.#next();
				};
				engine.onConnectionError = (e, status) => this.#onError(`Connection error while measuring ${type}: ${e}`, status);
				engine.onFatalError = (e) => this.#endTest(`Connection error while measuring ${type}: ${e}`, { skipLog: true });
				const measurementId = this.#measurementId;
				const msmIdx = this.#curMsmIdx;
				engine.onParallelLatencyError = (e, status) => {
					if (measurementId !== this.#measurementId || msmIdx !== this.#curMsmIdx) return;
					this.#onError(`Connection error while measuring loaded latency: ${e}`, status);
				};
				engine.play();
			}
		}
		this.#curEngine = engine;
		msmResults.started = true;
		this.onResultsChange({ type });
	}
};
var SpeedTestEngine = class extends MeasurementEngine {
	constructor(userConfig = {}) {
		super(userConfig);
		super.onFinish = this.#logFinalResults;
	}
	set onFinish(onFinish) {
		super.onFinish = (results, end) => {
			onFinish(results);
			this.#logFinalResults(results, end);
		};
	}
	onResultsLogged = () => {};
	#logFinalResults = (results, end) => {
		const apiUrl = this.config.logAimApiUrl;
		if (!apiUrl || end?.skipLog) return;
		logAimResults(results, {
			apiUrl,
			includeCredentials: this.config.includeCredentials,
			sessionId: this.config.sessionId,
			authorization: this.authorization
		}).then((response) => {
			this.onResultsLogged(response);
		});
	};
};
//#endregion
export { SpeedTestEngine as default };

