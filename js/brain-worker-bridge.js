/* brain-worker-bridge.js — T7.4
 *
 * Bridges the main-thread behavioral layer (connectome.js, fly-logic.js, main.js)
 * to the LIF Web Worker (sim-worker.js). Loads the full connectome binary,
 * initializes the worker, translates BRAIN.stimulate/drives to worker messages,
 * and aggregates worker fire states back into BRAIN.postSynaptic format.
 *
 * Loaded after connectome.js, before fly-logic.js and main.js.
 * Falls back to legacy BRAIN.update() if connectome.bin.gz fails to load.
 */

(function () {
	'use strict';

	/* ---- constants (tunable, may need adjustment in T7.7) ---- */

	// Intensity applied per worker tick for sustained stimulation.
	// With leak=0.95 and threshold=1.0, V_steady = intensity / (1 - leak).
	// At 0.15: V_steady = 3.0 → fires after ~8 ticks.
	var STIM_INTENSITY = 0.15;

	// Scale factor mapping (fired_fraction_per_group) to BRAIN.postSynaptic values.
	// The behavioral state machine reads accumulators derived from postSynaptic.
	// Motor neuron values of ~5-30 are needed to exceed behavior thresholds.
	var FIRE_STATE_SCALE = 100;

	/* ---- binary fetch with progress ---- */

	function fetchBinaryWithProgress(url, onProgress) {
		return new Promise(function (resolve, reject) {
			var xhr = new XMLHttpRequest();
			xhr.open('GET', url, true);
			xhr.responseType = 'arraybuffer';
			xhr.onprogress = function (e) {
				if (e.lengthComputable) {
					onProgress(e.loaded, e.total);
				} else {
					onProgress(e.loaded, 0);
				}
			};
			xhr.onload = function () {
				if (xhr.status >= 200 && xhr.status < 300) {
					resolve(xhr.response);
				} else {
					reject(new Error('HTTP ' + xhr.status + ' fetching ' + url));
				}
			};
			xhr.onerror = function () {
				reject(new Error('Network error fetching ' + url));
			};
			xhr.send();
		});
	}

	function updateLoadingProgress(loaded, total) {
		var subtitle = document.getElementById('connectomeSubtitle');
		if (!subtitle) return;
		var loadedMB = (loaded / (1024 * 1024)).toFixed(1);
		if (total > 0) {
			var totalMB = (total / (1024 * 1024)).toFixed(1);
			subtitle.textContent = 'Loading connectome... ' + loadedMB + ' / ' + totalMB + ' MB';
		} else {
			subtitle.textContent = 'Loading connectome... ' + loadedMB + ' MB';
		}
		subtitle.classList.add('loading');
	}

	/* ---- saved legacy reference ---- */

	var legacyUpdate = BRAIN.update;

	/* ---- module state ---- */

	var worker = null;
	var workerReady = false;
	var latestFireState = null;
	var neuronCount = 0;
	var groupCount = 0;
	var groupIdArr = null;       // Uint16Array[neuronCount] from worker
	var regionTypeArr = null;    // Uint8Array[neuronCount] from worker
	var groupIndices = null;     // Array of Uint32Array per group_id
	var groupSizes = null;       // Array[groupCount] of int from neuron_meta.json
	var groupNameToId = {};      // e.g. {'VIS_R1R6': 0, ...}
	var groupIdToName = [];      // e.g. [0: 'VIS_R1R6', ...]
	var pendingGroupSpikes = null; // Float32Array[groupCount] accumulated since last brain tick
	var pendingWorkerTicks = 0;
	var pendingDriveFrames = 0;  // brain ticks since last updateDrives (for batched catch-up)

	/* ---- initialization ---- */

	function initBridge() {
		var metaUrl = 'data/neuron_meta.json';
		var binUrl = 'data/connectome.bin.gz';
		var subtitle = document.getElementById('connectomeSubtitle');
		if (subtitle) {
			subtitle.textContent = 'Loading connectome...';
			subtitle.classList.add('loading');
		}

		fetch(metaUrl)
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + metaUrl);
				return res.json();
			})
			.then(function (meta) {
				groupCount = meta.group_count;
				groupSizes = meta.group_sizes;
				for (var i = 0; i < meta.groups.length; i++) {
					var g = meta.groups[i];
					groupNameToId[g.name] = g.id;
					groupIdToName[g.id] = g.name;
				}
				return fetchBinaryWithProgress(binUrl, updateLoadingProgress);
			})
			.then(function (buffer) {
				if (subtitle) {
					subtitle.textContent = 'Parsing connectome...';
				}
				worker = new Worker('js/sim-worker.js?v=2');
				worker.onmessage = handleWorkerMessage;
				worker.onerror = handleWorkerError;
				worker.postMessage({type: 'init', buffer: buffer}, [buffer]);
			})
			.catch(function (err) {
				console.warn('connectome.bin.gz load failed, using 59-group BRAIN.update():', err);
				BRAIN.update = legacyUpdate;
				if (subtitle) {
					subtitle.textContent = '59 neuron groups \u2014 FlyWire approximation (fallback)';
					subtitle.classList.remove('loading');
				}
			});
	}

	/* ---- worker message handling ---- */

	function handleWorkerMessage(e) {
		switch (e.data.type) {
		case 'ready':
			neuronCount = e.data.neuronCount;
			groupIdArr = new Uint16Array(e.data.groupId.buffer
				? e.data.groupId.buffer : e.data.groupId);
			regionTypeArr = new Uint8Array(e.data.regionType.buffer
				? e.data.regionType.buffer : e.data.regionType);
			pendingGroupSpikes = new Float32Array(groupCount);
			pendingWorkerTicks = 0;
			buildGroupIndices();
			workerReady = true;
			BRAIN.workerReady = true;
			BRAIN.workerNeuronCount = neuronCount;
			BRAIN.workerRegionType = regionTypeArr;
			BRAIN.workerGroupIdArr = groupIdArr;
			BRAIN.workerGroupIdToName = groupIdToName;
			BRAIN.workerGroupSizes = groupSizes;
			BRAIN.workerEdgeCount = e.data.edgeCount;

			// Reset postSynaptic to avoid stale legacy values
			for (var ps in BRAIN.postSynaptic) {
				BRAIN.postSynaptic[ps][0] = 0;
				BRAIN.postSynaptic[ps][1] = 0;
			}

			// Switch to worker-driven update
			BRAIN.update = workerUpdate;
			worker.postMessage({type: 'start'});
			console.log('Connectome worker ready: ' + neuronCount + ' neurons, ' +
				e.data.edgeCount + ' edges');
			// Update subtitle with actual counts
			var subtitle = document.getElementById('connectomeSubtitle');
			if (subtitle) {
				subtitle.textContent = neuronCount.toLocaleString() + ' neurons / ' +
					e.data.edgeCount.toLocaleString() + ' connections \u2014 FlyWire FAFB v783';
				subtitle.classList.remove('loading');
			}
			// Update header scale indicator
			var scaleEl = document.getElementById('scaleIndicator');
			if (scaleEl) {
				scaleEl.textContent = neuronCount.toLocaleString() + ' neurons / ' +
					e.data.edgeCount.toLocaleString() + ' connections \u2014 FlyWire FAFB v783';
				scaleEl.style.display = '';
			}
			break;

		case 'tick':
			latestFireState = e.data.fireState;
			BRAIN.latestFireState = e.data.fireState;
			BRAIN.workerFiredNeurons = e.data.firedNeurons || 0;
			// Every worker tick, so game-side decoders count each spike
			// exactly once (a 500ms brain tick spans ~5 worker ticks).
			if (BRAIN.onWorkerTick) BRAIN.onWorkerTick(e.data.fireState);
			if (pendingGroupSpikes && e.data.groupSpikeCounts) {
				for (var g = 0; g < groupCount; g++) {
					pendingGroupSpikes[g] += e.data.groupSpikeCounts[g] || 0;
				}
				pendingWorkerTicks++;
			}
			break;

		case 'stats':
			BRAIN.workerStats = e.data;
			/* Display performance info in the connectome subtitle */
			var statsSubtitle = document.getElementById('connectomeSubtitle');
			if (statsSubtitle && !statsSubtitle.classList.contains('loading')) {
				var firedPct = Math.round((e.data.firedNeurons || 0) / e.data.totalNeurons * 100);
				var activePct = Math.round(e.data.activeNeurons / e.data.totalNeurons * 100);
				statsSubtitle.textContent = neuronCount.toLocaleString() + ' neurons (' +
					firedPct + '% firing, ' + activePct + '% in active groups, ' +
					e.data.avgTickMs.toFixed(1) + 'ms/tick) \u2014 FlyWire FAFB v783';
			}
			break;

		case 'error':
			console.warn('Worker error: ' + e.data.message);
			if (workerReady) {
				console.warn('Falling back to 59-group BRAIN.update()');
				workerReady = false;
				BRAIN.workerReady = false;
				BRAIN.update = legacyUpdate;
			}
			break;
		}
	}

	function handleWorkerError(err) {
		console.warn('Worker crashed, falling back to 59-group BRAIN.update():', err.message || err);
		workerReady = false;
		BRAIN.workerReady = false;
		BRAIN.update = legacyUpdate;
		var subtitle = document.getElementById('connectomeSubtitle');
		if (subtitle) {
			subtitle.textContent = '59 neuron groups \u2014 FlyWire approximation (fallback)';
			subtitle.classList.remove('loading');
		}
	}

	/* ---- build group-to-neuron-indices lookup ---- */

	function buildGroupIndices() {
		// Count neurons per group
		var counts = new Uint32Array(groupCount);
		for (var i = 0; i < neuronCount; i++) {
			counts[groupIdArr[i]]++;
		}
		// Allocate typed arrays per group
		groupIndices = new Array(groupCount);
		for (var g = 0; g < groupCount; g++) {
			groupIndices[g] = new Uint32Array(counts[g]);
			counts[g] = 0; // reuse as write offset
		}
		// Fill indices
		for (var i = 0; i < neuronCount; i++) {
			var gid = groupIdArr[i];
			groupIndices[gid][counts[gid]++] = i;
		}
	}

	/* ---- virtual VNC motor layer ---- */
	// FlyWire FAFB covers the brain only. Leg and wing motor neurons live in
	// the ventral nerve cord (VNC), which is a separate dataset. Descending
	// neurons (GNG_DESC) are the brain's motor output to the VNC. This function
	// synthesizes what the VNC would produce by distributing descending neuron
	// activation across the motor groups that BRAIN.motorcontrol() reads.
	// Context from central circuits biases the distribution toward the
	// appropriate motor pattern (walk vs flight vs groom vs feed).

	var MOTOR_SCALE = 0.6; // overall gain from descending -> motor groups

	function readPS(name) {
		if (!BRAIN.postSynaptic[name]) return 0;
		return BRAIN.postSynaptic[name][BRAIN.nextState] || 0;
	}

	function addPS(name, val) {
		if (!BRAIN.postSynaptic[name]) return;
		BRAIN.postSynaptic[name][BRAIN.nextState] += val;
	}

	function synthesizeMotorOutputs() {
		var desc = readPS('GNG_DESC');
		var vcpg = readPS('VNC_CPG');

		// Read central circuit activations to infer motor intent
		var cxPfn = readPS('CX_PFN');    // path integration -> locomotion
		var cxFc = readPS('CX_FC');       // fan-shaped body -> locomotion
		var cxEpg = readPS('CX_EPG');     // heading -> steering
		var cxHd = readPS('CX_HDELTA');   // heading delta -> turning
		var sezFeed = readPS('SEZ_FEED');
		var sezGroom = readPS('SEZ_GROOM');
		var mbApp = readPS('MB_MBON_APP'); // approach
		var mbAv = readPS('MB_MBON_AV');   // avoidance
		var lhApp = readPS('LH_APP');      // lateral horn approach
		var lhAv = readPS('LH_AV');        // lateral horn avoidance
		var dFear = readPS('DRIVE_FEAR');
		var dGroom = readPS('DRIVE_GROOM');
		var prob = readPS('MN_PROBOSCIS');
		var head = readPS('MN_HEAD');
		var dnStartle = readPS('DN_STARTLE');
		var noci = readPS('NOCI');

		// Compute motor intent weights (unnormalized, then used proportionally)
		var walkIntent = (cxPfn + cxFc + cxEpg) * 0.3 + (mbApp + lhApp) * 0.5 + (desc + vcpg) * 0.2;
		var flightIntent = dFear * 2.0 + (mbAv + lhAv) * 0.8 + dnStartle * 1.5 + noci * 1.0;
		var groomIntent = dGroom * 1.5 + sezGroom * 1.0;
		var feedIntent = sezFeed * 1.0 + prob * 0.5;
		var descProxy = Math.max(
			walkIntent * 0.45,
			flightIntent * 0.35,
			groomIntent * 0.3,
			feedIntent * 0.25
		);
		if (descProxy > desc) {
			desc = descProxy;
			if (BRAIN.postSynaptic.GNG_DESC) {
				BRAIN.postSynaptic.GNG_DESC[BRAIN.nextState] = desc;
			}
		}
		var total = desc + vcpg;
		if (total < 0.5) return;

		// Baseline: descending activity drives walking (the default motor program)
		var baseWalk = total * MOTOR_SCALE;

		// Scale walk by locomotor intent from CX
		var walkDrive = baseWalk * (1.0 + walkIntent * 0.1);

		// Symmetric left/right walk output. Steering is handled by the behavioral
		// layer (computeMovementForBehavior) using targetDir, not by leg asymmetry.
		// A small random jitter prevents perfectly straight lines.
		var jitter = (Math.random() - 0.5) * 0.04;

		// [FULL-CONNECTOME fix, 2026-09-17] Only L2/L3 and R2/R3 (middle+hind
		// legs) get this generic walk drive -- L1/R1 (front legs) are
		// deliberately excluded here. Reason: fly-pixel-game.html's
		// motorcontrol() computes accumGroom as
		// `abdomen + (abdomen>0?head:0) + Math.min(legL1, legR1)`, using
		// "both front legs active together" as a genuine grooming signal
		// (real flies rub L1+R1 together; ordinary tripod-gait walking does
		// NOT drive them symmetrically). That assumption held in the
		// original 70-group flybrain, where only a small fixed CPG_MASTER
		// weight (+4) reached MN_LEG_L1/R1 during walking. Here, VNC has
		// zero real neurons, so this synthesis IS the entire walk pathway --
		// feeding L1/R1 the same (nearly symmetric, ±jitter only) walkL/walkR
		// as every other leg pair made min(legL1,legR1) rise with ANY
		// walking, not just grooming, so the fly kept "grooming" almost
		// immediately regardless of actual dust (root-caused together with
		// the DRIVE_GROOM/dust desync fixed in fly-pixel-game.html
		// runBrainTick). Leaving L1/R1 walk-free (real connectome activity
		// only) restores that signal as an actual groom-only indicator. The
		// remaining 2 legs/side split the same total walkDrive (was /3, now
		// /2) so overall walk thrust (accumWalkLeft/Right, used for
		// speed/animation) is unchanged.
		var walkL = walkDrive * (1.0 + jitter) / 2.0;
		var walkR = walkDrive * (1.0 - jitter) / 2.0;

		addPS('MN_LEG_L2', walkL);
		addPS('MN_LEG_L3', walkL);
		addPS('MN_LEG_R2', walkR);
		addPS('MN_LEG_R3', walkR);

		// Flight: strong avoidance/fear/startle -> wing activation
		if (flightIntent > 1.0) {
			var flightDrive = flightIntent * MOTOR_SCALE * 0.7;
			addPS('MN_WING_L', flightDrive);
			addPS('MN_WING_R', flightDrive);
		}

		// Startle: fear burst -> DN_STARTLE equivalent
		if (dFear > 3.0) {
			addPS('DN_STARTLE', dFear * MOTOR_SCALE);
		}

		// Grooming: groom intent -> abdomen + front legs (motorcontrol reads these)
		if (groomIntent > 1.0) {
			addPS('MN_ABDOMEN', groomIntent * MOTOR_SCALE * 0.3);
		}

		// Feed intent: boost proboscis (already has real neurons, just amplify)
		if (feedIntent > 0.5) {
			addPS('MN_PROBOSCIS', feedIntent * MOTOR_SCALE * 0.3);
		}
	}

	/* ---- worker-driven BRAIN.update replacement ---- */

	function workerUpdate() {
		pendingDriveFrames = Math.min(pendingDriveFrames + 1, 20);

		// One-shot stimuli (e.g. NOCI pain) are sent immediately via the worker
		// 'stimulate' message for direct V injection, not gated on worker ticks.
		// This prevents overwrite by subsequent setStimulusState replacements.
		sendOneShotStimuli();

		// Only run the full pipeline when new worker tick data is available.
		// updateDrives and sendStimulation are throttled to match motor pipeline
		// frequency, preventing drive decay from attenuating transient signals
		// (e.g. fear spikes) before the motor pipeline processes them.
		if (latestFireState || pendingWorkerTicks > 0) {
			// Batch-run drive updates for all elapsed frames since last pipeline run.
			// Calling updateDrives N times preserves per-frame accumulation/decay
			// rates (e.g. fear *= 0.85 runs N times giving 0.85^N total decay).
			for (var i = 0; i < pendingDriveFrames; i++) {
				BRAIN.updateDrives();
			}
			pendingDriveFrames = 0;

			// Send sustained stimulation state to worker
			sendStimulation();

			// Aggregate worker spikes into BRAIN.postSynaptic
			aggregateFireState();

			// Virtual group bypass: groups with 0 real neurons
			var vd = BRAIN.drives;
			if (BRAIN.postSynaptic['DRIVE_FEAR'])
				BRAIN.postSynaptic['DRIVE_FEAR'][BRAIN.nextState] = vd.fear * FIRE_STATE_SCALE;
			if (BRAIN.postSynaptic['DRIVE_CURIOSITY'])
				BRAIN.postSynaptic['DRIVE_CURIOSITY'][BRAIN.nextState] = vd.curiosity * FIRE_STATE_SCALE;
			if (BRAIN.postSynaptic['DRIVE_GROOM'])
				BRAIN.postSynaptic['DRIVE_GROOM'][BRAIN.nextState] = vd.groom * FIRE_STATE_SCALE;

			// Synthesize VNC motor outputs from descending neuron activity
			synthesizeMotorOutputs();

			// Motor control
			BRAIN.motorcontrol();

			// State swap
			for (var ps in BRAIN.postSynaptic) {
				BRAIN.postSynaptic[ps][BRAIN.thisState] =
					BRAIN.postSynaptic[ps][BRAIN.nextState];
			}
			var temp = BRAIN.thisState;
			BRAIN.thisState = BRAIN.nextState;
			BRAIN.nextState = temp;
		}
	}

	/* ---- translate BRAIN.stimulate + BRAIN.drives to worker stimulation ---- */

	function collectOneShotSegments() {
		// NOCI has 0 real neurons in this dataset, so the pain flag is only
		// cleared here; shake/wire pain reaches real neurons via GNG_DESC
		// (fly-pixel-game.html stimulateFearGngDesc).
		BRAIN.stimulate.nociception = false;
		return [];
	}

	function collectStimulationSegments() {
		var segs = [];
		var d = BRAIN.drives;

		// Drive stimulation
		if (d.hunger > 0.2) {
			var pulses = d.hunger > 0.6 ? 3 : (d.hunger > 0.4 ? 2 : 1);
			segs.push({name: 'DRIVE_HUNGER', intensity: STIM_INTENSITY * d.hunger * pulses});
		}
		if (d.fear > 0.05) {
			var pulses = d.fear > 0.5 ? 3 : (d.fear > 0.2 ? 2 : 1);
			segs.push({name: 'DRIVE_FEAR', intensity: STIM_INTENSITY * d.fear * pulses});
		}
		if (d.fatigue > 0.3) {
			segs.push({name: 'DRIVE_FATIGUE', intensity: STIM_INTENSITY * d.fatigue});
		}
		if (d.curiosity > 0.2) {
			var pulses = d.curiosity > 0.5 ? 2 : 1;
			segs.push({name: 'DRIVE_CURIOSITY', intensity: STIM_INTENSITY * d.curiosity * pulses});
		}
		if (d.groom > 0.3) {
			segs.push({name: 'DRIVE_GROOM', intensity: STIM_INTENSITY * d.groom});
		}

		// Sensory stimulation
		if (BRAIN.stimulate.touch) {
			segs.push({name: 'MECH_BRISTLE', intensity: STIM_INTENSITY});
			if (BRAIN.stimulate.touchLocation === 'head' ||
				BRAIN.stimulate.touchLocation === 'thorax') {
				segs.push({name: 'MECH_BRISTLE', intensity: STIM_INTENSITY});
			}
		}
		if (BRAIN.stimulate.foodNearby) {
			segs.push({name: 'OLF_ORN_FOOD', intensity: STIM_INTENSITY});
		}
		// Body state scales taste receptor sensitivity (hunger -> sweet GRNs,
		// thirst -> water GRNs); set by fly-pixel-game.html runBrainTick.
		var gs = BRAIN.stimulate.sweetGain || 1;
		var gw = BRAIN.stimulate.waterGain || 1;
		if (BRAIN.stimulate.foodContact) {
			// Яблуко: солодке + легка водяниста нотка (~85% води в реальному яблуці).
			segs.push({name: 'GUS_GRN_SWEET', intensity: STIM_INTENSITY * gs});
			segs.push({name: 'GUS_GRN_WATER', intensity: STIM_INTENSITY * 0.3 * gw});
		}
		// [FULL-CONNECTOME game addition — NOT in upstream collectStimulationSegments()]
		// waterContact (кавова пляма) і meatContact (салямі) — цей самий
		// шаблон, що вже є для foodContact вище, просто раніше не був
		// дописаний тут: під worker-мозком це означало, що GUS_GRN_WATER/
		// GUS_GRN_BITTER (смак кавової плями) НІКОЛИ не спрацьовували —
		// повністю мертвий шлях, доки не знайдено зараз. Легасі-шлях
		// (dendriteAccumulate у fly-pixel-game.html) це вже робив, просто
		// worker його не читає (той самий клас багів, що mug/wire/roach
		// до Фази 2, див. HANDOFF.md).
		if (BRAIN.stimulate.waterContact) {
			segs.push({name: 'GUS_GRN_WATER', intensity: STIM_INTENSITY * gw});
			segs.push({name: 'GUS_GRN_BITTER', intensity: STIM_INTENSITY * 0.4});
			segs.push({name: 'GUS_GRN_SWEET', intensity: STIM_INTENSITY * 0.25 * gs});
		}
		if (BRAIN.stimulate.meatContact) {
			segs.push({name: 'GUS_GRN_WATER', intensity: STIM_INTENSITY * 0.4 * gw});
		}
		if (BRAIN.stimulate.dangerOdor) {
			segs.push({name: 'OLF_ORN_DANGER', intensity: STIM_INTENSITY});
		}
		if (BRAIN.stimulate.wind) {
			segs.push({name: 'MECH_JO', intensity: STIM_INTENSITY * BRAIN.stimulate.windStrength});
		}
		if (BRAIN.stimulate.lightLevel > 0.2) {
			segs.push({name: 'VIS_R1R6', intensity: STIM_INTENSITY * BRAIN.stimulate.lightLevel});
		}
		if (BRAIN.stimulate.temperature > 0.65) {
			var warmIntensity = (BRAIN.stimulate.temperature - 0.5) * 2;
			segs.push({name: 'THERMO_WARM', intensity: STIM_INTENSITY * warmIntensity});
		} else if (BRAIN.stimulate.temperature < 0.35) {
			var coolIntensity = (0.5 - BRAIN.stimulate.temperature) * 2;
			segs.push({name: 'THERMO_COOL', intensity: STIM_INTENSITY * coolIntensity});
		}
		// [FULL-CONNECTOME fix, 2026-09-17] Was a flat on/off pulse gated on
		// lightLevel>0.1 -- ignored fly-pixel-game.html's ALREADY-COMPUTED
		// BRAIN.stimulate.opticFlow (real brightness gradient between current
		// position and a point ahead on heading, via brightnessAt(); see
		// runBrainTick there). That richer signal was already wired into the
		// LEGACY dendriteAccumulate path (BRAIN.update()'s
		// `if (BRAIN._isMoving && opticFlow>0.005) dendriteAccumulateScaled(...)`)
		// but never reached the worker path -- same class of dead-pathway bug
		// as mug/wire/waterContact before it. Wiring it in here gives VIS_LPTC
		// a continuous, motion-and-scene-dependent signal instead of a flat
		// "moving or not" pulse -- part of adding real visual complexity
		// (brightness now also varies with zone texture, see
		// ZONE_REFLECTIVITY in brightnessAt()), so optic flow actually has
		// something to detect even away from a defined light source.
		// VISION_OPTIC_FLOW_GAIN=8 mirrors fly-pixel-game.html's own constant
		// (not importable here -- separate script scope).
		if (BRAIN._isMoving && BRAIN.stimulate.opticFlow > 0.005) {
			segs.push({name: 'VIS_LPTC', intensity: STIM_INTENSITY * Math.min(1, BRAIN.stimulate.opticFlow * 8)});
		}

		// Tonic background activity
		var tonicIntensity = BRAIN.stimulate.lightLevel === 0 ? 0.03 : 0.08;
		segs.push({name: 'CX_FC', intensity: tonicIntensity});
		segs.push({name: 'CX_EPG', intensity: tonicIntensity});
		segs.push({name: 'CX_PFN', intensity: tonicIntensity});

		return segs;
	}

	function sendOneShotStimuli() {
		var segs = collectOneShotSegments();
		if (!worker || segs.length === 0) return;
		for (var s = 0; s < segs.length; s++) {
			var gid = groupNameToId[segs[s].name];
			if (gid === undefined) continue;
			var idx = groupIndices[gid];
			if (!idx || idx.length === 0) continue;
			var intensities = new Float32Array(idx.length);
			for (var k = 0; k < idx.length; k++) {
				intensities[k] = segs[s].intensity;
			}
			worker.postMessage({type: 'stimulate', indices: idx, intensities: intensities});
		}
	}

	function sendStimulation() {
		if (!worker) return;

		var segs = collectStimulationSegments();

		// Translate named segments to indexed segments using closure state
		var totalLen = 0;
		var indexedSegs = [];
		for (var i = 0; i < segs.length; i++) {
			var gid = groupNameToId[segs[i].name];
			if (gid === undefined) continue;
			var idx = groupIndices[gid];
			if (!idx || idx.length === 0) continue;
			indexedSegs.push({indices: idx, intensity: segs[i].intensity});
			totalLen += idx.length;
		}

		if (totalLen === 0) {
			worker.postMessage({type: 'setStimulusState', indices: null, intensities: null});
			return;
		}

		var allIndices = new Uint32Array(totalLen);
		var allIntensities = new Float32Array(totalLen);
		var offset = 0;
		for (var s = 0; s < indexedSegs.length; s++) {
			var seg = indexedSegs[s];
			allIndices.set(seg.indices, offset);
			for (var k = 0; k < seg.indices.length; k++) {
				// [FULL-CONNECTOME fix, 2026-09-17] Per-neuron jitter (0.7-1.3x),
				// re-rolled every call. Found live (3D viz + group-level firing
				// counts): every neuron in a group got the EXACT same intensity
				// every tick (no noise anywhere in sim-worker.js's LIF dynamics),
				// so a large group under sustained sub-threshold stimulation
				// (e.g. VIS_R1R6 at moderate lightLevel needs ~15-16 consecutive
				// ticks to cross threshold=1.0 given leak=0.95) charges up in
				// perfect lockstep and then ALL fire on the SAME tick -- observed
				// directly: one sample had 11,341 of 11,487 VIS_R1R6 neurons
				// (99%) fire simultaneously, vs ~0% nearly all other ticks. That
				// all-or-nothing flash (not a graded, proportional-to-stimulus
				// response) is why the 3D view mostly shows only the central
				// circuits glowing (which run every tick regardless) and rarely
				// catches sensory groups mid-flash. Jitter desyncs the
				// population's charge-up so neurons cross threshold spread over
				// a range of ticks instead of one instant -- smoother, more
				// continuous-looking sensory activity, same average intensity.
				allIntensities[offset + k] = seg.intensity * (0.7 + Math.random() * 0.6);
			}
			offset += seg.indices.length;
		}

		worker.postMessage({type: 'setStimulusState', indices: allIndices, intensities: allIntensities});
	}

	/* ---- aggregate fire state into BRAIN.postSynaptic ---- */

	function aggregateFireState() {
		var groupFires = new Float32Array(groupCount);
		var tickWindow = pendingWorkerTicks;

		if (pendingGroupSpikes && pendingWorkerTicks > 0) {
			groupFires.set(pendingGroupSpikes);
		} else if (latestFireState) {
			var fire = latestFireState;
			tickWindow = 1;
			for (var i = 0; i < neuronCount; i++) {
				if (fire[i]) {
					groupFires[groupIdArr[i]]++;
				}
			}
		}

		if (tickWindow < 1) tickWindow = 1;

		// Normalize by group size, scale, and write to BRAIN.postSynaptic[nextState]
		for (var g = 0; g < groupCount; g++) {
			var name = groupIdToName[g];
			if (!name || !BRAIN.postSynaptic[name]) continue;
			var size = groupSizes[g];
			var windowActivation = size > 0
				? (groupFires[g] / (size * tickWindow)) * FIRE_STATE_SCALE
				: 0;
			var prevActivation = BRAIN.postSynaptic[name][BRAIN.thisState] || 0;
			var activation = Math.max(windowActivation, prevActivation * 0.75);
			BRAIN.postSynaptic[name][BRAIN.nextState] = activation;
		}

		if (pendingGroupSpikes) pendingGroupSpikes.fill(0);
		pendingWorkerTicks = 0;
		latestFireState = null;
	}

	/* ---- pause / resume API for visibilitychange ---- */

	function stopWorker() {
		if (!workerReady || !worker) return;
		worker.postMessage({type: 'stop'});
		worker.postMessage({type: 'setStimulusState', indices: null, intensities: null});
		latestFireState = null;
		if (pendingGroupSpikes) pendingGroupSpikes.fill(0);
		pendingWorkerTicks = 0;
		BRAIN.latestFireState = null;
		pendingDriveFrames = 0;
	}

	function startWorker() {
		if (!workerReady || !worker) return;
		// No 'reset': resume from the paused membrane state so a hidden tab
		// continues seamlessly.
		if (pendingGroupSpikes) pendingGroupSpikes.fill(0);
		pendingWorkerTicks = 0;
		pendingDriveFrames = 0;
		worker.postMessage({type: 'start'});
	}

	BRAIN.stopWorker = stopWorker;
	BRAIN.startWorker = startWorker;

	// [FULL-CONNECTOME game hook — NOT part of upstream snedea/flybrain,
	// added for fly-pixel-game.html's per-stimulus Kenyon-cell learning
	// (see applyMBPlasticity()/senseMug()/senseWire() there).] One-shot
	// direct-V injection into arbitrary neuron INDICES (same semantics as
	// sendOneShotStimuli's NOCI path — not overwritten by the periodic
	// setStimulusState group-level calls above), so game code can drive a
	// sparse, stimulus-specific subset of a real group (e.g. a fixed slice
	// of MB_KC) instead of the whole group.
	BRAIN.stimulateIndices = function (indices, intensity) {
		if (!worker || !indices || indices.length === 0) return;
		var intensities = new Float32Array(indices.length);
		for (var k = 0; k < indices.length; k++) intensities[k] = intensity;
		worker.postMessage({type: 'stimulate', indices: indices, intensities: intensities});
	};

	/* ---- start / test mode ---- */

	if (BRAIN._testMode) {
		BRAIN._bridge = {
			synthesizeMotorOutputs: synthesizeMotorOutputs,
			aggregateFireState: aggregateFireState,
			buildGroupIndices: buildGroupIndices,
			collectStimulationSegments: collectStimulationSegments,
			collectOneShotSegments: collectOneShotSegments,
			workerUpdate: workerUpdate,
			FIRE_STATE_SCALE: FIRE_STATE_SCALE,
			MOTOR_SCALE: MOTOR_SCALE,
			STIM_INTENSITY: STIM_INTENSITY,
			_setGroupState: function (gc, nc, gIdArr, gSizes, gIdToNameArr) {
				groupCount = gc;
				neuronCount = nc;
				groupIdArr = gIdArr;
				groupSizes = gSizes;
				groupIdToName = gIdToNameArr;
				groupNameToId = {};
				for (var i = 0; i < gIdToNameArr.length; i++) {
					if (gIdToNameArr[i]) groupNameToId[gIdToNameArr[i]] = i;
				}
				pendingGroupSpikes = new Float32Array(gc);
				pendingWorkerTicks = 0;
				pendingDriveFrames = 0;
			},
			_setFireState: function (fireState, spikes, ticks) {
				latestFireState = fireState;
				if (spikes) pendingGroupSpikes = spikes;
				pendingWorkerTicks = ticks;
			},
			_getGroupIndices: function () {
				return groupIndices;
			},
		};
	} else {
		initBridge();
	}

})();
