var numForceGroupsParam = local.parameters.setup.numForceGroups;
var numOrbGroupsParam = local.parameters.setup.numOrbGroups;
var numMacrosParam = local.parameters.setup.numMacros;
var isConnectedParam = local.parameters.isConnected;
var syncDataTrigger = local.parameters.syncData;

var macrosGroup = local.parameters.macros;
var forceGroupsGroup = local.parameters.forceGroups;
var orbGroupsGroup = local.parameters.orbGroups;

var forces = [];
var orbGroups = [];
var macros = [];

//Unity links, taken from the OSCQuery structure after each sync
var unityBallet = null;
var unityForceGroupsParam = null;
var unityOrbGroupsParam = null;

// One entry per orb / force group parameter, rebuilt when the groups or macros change : a value change no longer
// walks the whole module tree nor searches the Unity parameter by name again.
var entries = [];        // every entry, for macro changes and full pushes
var entriesByKey = {};   // "<group>/<category>/<parameter>" -> entry
var unityTargets = {};   // same key -> { param : Unity parameter in local.values }, emptied after each sync

// LINK WITH UNITY
// A sync ("Sync Data") is heavy on both sides : Unity describes its whole scene on its main thread (about 44 ms and
// 2.5 MB of garbage for the show scene), Chataigne rebuilds its tree and sends every value back. Chataigne's OSCQuery
// module reconnects its websocket alone every 5 s, but only once a sync has succeeded. A sync is only requested when
// needed :
// - Unity not reachable yet (or after a failed sync) : one attempt every RETRY_DELAY seconds, cheap while Unity is off
// - the websocket came back without a sync (Unity restarted) : one sync, to get the structure and push the values
// - Unity is creating new groups (Num Orb / Force Groups raised) : one sync, GROUP_SYNC_DELAY seconds later
// Every sync is noticed through the "Sync Data" trigger, whoever pressed it, so these rules never start a second one.
// The decisions rely on time, not on the order of Chataigne's events : after a sync, the websocket can reconnect
// before or after the new structure arrives (they come from two threads). Reacting to that order used to restart a
// sync in a loop, every ~6 s, each one freezing Unity for 110-145 ms.
// Do not add an action that syncs when "Is Connected" turns on : a sync disconnects and reconnects, it would loop.
var RETRY_DELAY = 10;
var SYNC_TIMEOUT = 8;        // no structure received this long after a sync : Unity was not reachable
var RECONNECT_GRACE = 20;    // a reconnection this soon after a sync comes from that sync
var GROUP_SYNC_DELAY = 1.5;  // leaves Unity the time to create the new groups

var clock = 0;               // seconds, advanced by update()
var lastSyncTime = 0;
var syncPending = false;
var unityReachable = false;
var wasConnected = false;
var groupSyncTime = -1;
var retryLogged = false;

var danceGroupParameters = {
	"Transform":
	{
		"Position": { "type": "p3d", "default": [0, 0, 0], "customComponent": "Transform/position" },
		"Rotation": { "type": "p3d", "default": [0, 0, 0], "customComponent": "Transform/rotation" },
	},
	"Patterns": {
		"Count": { "type": "float", "default": 1, "min": 1, "max": 10, "noMacro": true },
		"Pattern Size": { "type": "float", "default": 1, "min": 0, "max": 20 },
		"Pattern Size Spread": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Pattern Axis Spread": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Line Pattern Weight": { "type": "float", "default": 0, "min": 0, "max": 1, "customComponent": "LineDancePattern/weight" },
		"Line Pattern Speed Weight": { "type": "float", "default": 0, "min": 0, "max": 1, "customComponent": "LineDancePattern/speedWeight" },
		"Circle Pattern Weight": { "type": "float", "default": 1, "min": 0, "max": 1, "customComponent": "CircleDancePattern/weight" },
		"Circle Pattern Speed Weight": { "type": "float", "default": 1, "min": 0, "max": 1, "customComponent": "CircleDancePattern/speedWeight" },
		"Manual Pattern Weight": { "type": "float", "default": 0, "min": 0, "max": 1, "customComponent": "ManualDancePattern/weight" }
	},
	"Animation": {
		"Pattern Speed": { "type": "float", "default": 0.1, "min": -1, "max": 1 },
		"Pattern Speed Random": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Pattern Time Offset": { "type": "float", "default": 0, "min": 0, "max": 1 }

	},
	"Dancer": {
		"Dancer Size": { "type": "float", "default": 1, "min": 0, "max": 20 },
		"Emitter Scale": { "type": "p3d", "default": [1, 1, 1] },
		"Dancer Hyper Size": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Dancer Size Spread": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Dancer Weight Size Factor": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Dancer Intensity": { "type": "float", "default": 1, "min": 0, "max": 1 },
		"Dancer Rotation": { "type": "p3d", "default": [0, 0, 0] },
		"Dancer Look At": { "type": "p3d", "default": [0, 1, 0] },
		"Dancer Look At Mode": { "type": "float", "default": 0, "min": 0, "max": 2 }
	}
};

var forceGroupParameters = {
	"General": {
		"Force Factor Inside": { "type": "float", "default": 1, "min": 0, "max": 1 },
		"Force Factor Outside": { "type": "float", "default": 0, "min": 0, "max": 1 }
	},
	"Radial": {
		"Radial Intensity": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Radial Frequency": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Radial InOut": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Radial Speed Wave": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Radial Amplitude Wave": { "type": "float", "default": 0, "min": 0, "max": 1 }
	},
	"Axial": {
		"Axial Intensity": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Axis Multiplier": { "type": "p3d", "default": [0, 1, 0] },
		"Axial Factor": { "type": "float", "default": 1, "min": 1, "max": 3 },
		"Axial Frequency": { "type": "p3d", "default": [0, 0, 0] },
		"Axial Speed Wave": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Axial Amplitude Wave": { "type": "float", "default": 0, "min": 0, "max": 1 }
	},
	"Linear": {
		"Linear Intensity": { "type": "float", "default": 0, "min": 0, "max": 1 }
	},
	"Orthoradial": {
		"Ortho Intensity": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Ortho Inner Radius": { "type": "float", "default": 0.5, "min": 0, "max": 1 },
		"Ortho Factor": { "type": "float", "default": 2, "min": 1, "max": 3 },
		"Ortho Clockwise": { "type": "float", "default": 1, "min": -1, "max": 1 }
	},
	"Turbulence Curl": {
		"Curl Intensity": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Curl Frequency": { "type": "float", "default": 0, "min": 0, "max": 5 },
		"Curl Drag": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Curl Octaves": { "type": "float", "default": 1, "min": 1, "max": 8 },
		"Curl Roughness": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Curl Lacunarity": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Curl Scale": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Curl Translation": { "type": "float", "default": 0, "min": 0, "max": 1 }
	},
	"Perlin": {
		"Perlin Intensity": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Perlin Frequency": { "type": "float", "default": 0, "min": 0, "max": 5 },
		"Perlin Octaves": { "type": "float", "default": 1, "min": 1, "max": 8 },
		"Perlin Roughness": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Perlin Lacunarity": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Perlin Translation Speed": { "type": "float", "default": 0, "min": 0, "max": 1 }
	},
	"Orthoaxial": {
		"Orthoaxial Intensity": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Orthoaxial Inner Radius": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Orthoaxial Factor": { "type": "float", "default": 1, "min": 1, "max": 3 },
		"Orthoaxial Clockwise": { "type": "float", "default": 0, "min": -1, "max": 1 }
	},
	"Spiral": {
		"Spiral Intensity": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Spiral Frequency": { "type": "float", "default": 1, "min": 0, "max": 3 },
		"Spiral Vertical Force": { "type": "float", "default": 0.5, "min": 0, "max": 1 },
		"Spiral Direction": { "type": "float", "default": 0, "min": 0, "max": 1 }		
	}
};


var orbGroupParameters = {
	"General": {
		"Life": { "type": "float", "default": 20, "min": 0, "max": 120 },
		"Infinite Life": { "type": "bool", "default": false },
		"Emitter Shape": { "type": "enum", "default": "Sphere", "values": ["Sphere", "Plane", "Torus", "Cube", "Pipe", "Egg", "Line", "Circle", "Merkaba", "Pyramid", "Custom", "Augmenta"] },
		"Render Type": {"type": "enum", "default" : "UnlitAdditive", "values":["UnlitOpaque", "UnlitAdditive", "LitQuad", "LitMesh"]},
		"Emitter Surface Factor": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Emitter Volume Factor": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Emitter Position Noise": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Emitter Position Noise Frequency": { "type": "float", "default": 1, "min": 0, "max": 5 },
		"Emitter Position Noise Radius": { "type": "float", "default": 0.1, "min": 0, "max": 1 },
		"Custom Mesh Name":{"type":"string", "default":"sphere"},
	},
	"Appearance": {
		"Color": { "type": "color", "default": [.8, 2, .05] },
		"Color Life": { "type": "color", "default": [0, 0, 0] },
		"Color Life Range": { "type": "float", "default": 1, "min": 0, "max": 1 },
		"Color Life Blend": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Color Speed": { "type": "color", "default": [0, 0, 0] },
		"Color Speed Range": { "type": "float", "default": 1, "min": 0, "max": 1 },
		"Color Speed Blend": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Color Max Speed": { "type": "float", "default": 1	, "min": 0, "max": 1 },
		"Alpha": { "type": "float", "default": 0.2, "min": 0, "max": 1 },
		"HDR Multiplier": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Alpha Speed Threshold": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Texture Opacity": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Particle Size": { "type": "float", "default": 0, "min": 0, "max": 1 },
	},
	"Physics": {
		"Force Weight": { "type": "float", "default": 1, "min": 0, "max": 1 },
		"Drag": { "type": "float", "default": 0.5, "min": 0, "max": 1 },
		"Velocity Drag": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Noisy Drag": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Noisy Drag Frequency": { "type": "float", "default": 0, "min": 0, "max": 1 },
		"Activate Collision": { "type": "bool", "default": false }
	}
};


//CALLBACKS
function init() {
	// update() only drives the link with Unity : no need for the default 50 calls per second
	script.setUpdateRate(4);

	setup();
	linkUnity();
	wasConnected = isConnectedParam.get();
	unityReachable = wasConnected;
}

// Runs on the script's own thread : keep it to the link with Unity, nothing that rebuilds containers
function update(deltaTime)
{
	clock += deltaTime;
	var connected = isConnectedParam.get();

	if (syncPending && clock - lastSyncTime > SYNC_TIMEOUT) {
		syncPending = false;
		unityReachable = false; // the module only reconnects alone after a successful sync
	}

	if (!syncPending) {
		if (connected && !wasConnected && clock - lastSyncTime > RECONNECT_GRACE) {
			requestSync("Unity is back, syncing once");
		} else if (!connected && !unityReachable && clock - lastSyncTime > RETRY_DELAY) {
			if (!retryLogged) script.log("Unity not reachable, trying again every " + RETRY_DELAY + " s");
			retryLogged = true;
			requestSync(null);
		} else if (groupSyncTime >= 0 && clock >= groupSyncTime && (connected || unityReachable)) {
			requestSync("Syncing once to reach the new groups");
		}
	}

	wasConnected = connected;
}

function requestSync(reason) {
	if (reason != null) script.log(reason);
	// Also recorded by moduleParameterChanged (like a sync from the button or an action), set here in case
	// Chataigne delivers that call later
	lastSyncTime = clock;
	syncPending = true;
	groupSyncTime = -1;
	syncDataTrigger.trigger();
}

function scheduleGroupSync() {
	groupSyncTime = clock + GROUP_SYNC_DELAY;
}


function moduleParameterChanged(param) {

	if (param.is(isConnectedParam)) return; // read by update()

	if (param.is(syncDataTrigger)) {
		lastSyncTime = clock;
		syncPending = true;
		groupSyncTime = -1;
		return;
	}

	if (param.is(numForceGroupsParam)) {
		setupForces();
		linkArrays();
		if (setUnityCount(unityForceGroupsParam, numForceGroupsParam.get())) scheduleGroupSync();
	} else if (param.is(numOrbGroupsParam)) {
		setupOrbs();
		linkArrays();
		if (setUnityCount(unityOrbGroupsParam, numOrbGroupsParam.get())) scheduleGroupSync();
	} else if (param.is(numMacrosParam)) {
		setup();
	} else if (param.getParent().is(macrosGroup)) {
		updateEntriesForMacro(macrosGroup.getControllables().indexOf(param));
	} else if (param.is(local.parameters.setup.resetAllMacro)) {
		resetGroupMacro(orbGroups);
		resetGroupMacro(forces);
	} else if (param.is(local.parameters.setup.sendDataToUnity)) {
		requestSync("Send Data to Unity"); // Same as pressing Sync Data
	} else {
		// Base value or macro weight of an orb / force group parameter
		var p4 = param.getParent(4);
		if (p4 == forceGroupsGroup || p4 == orbGroupsGroup) {
			var entry = entriesByKey[param.getParent(3).niceName + "/" + param.getParent(2).niceName + "/" + param.getParent().niceName];
			if (entry != null) updateEntry(entry);
		}
	}
}

// Called by Chataigne once the structure received from Unity is in place (after every successful sync)
function dataStructureEvent() {
	syncPending = false;
	unityReachable = true;
	retryLogged = false;
	linkUnity();
}


//UPDATE
function updateEntriesForMacro(index) {
	if (index < 0) return;
	for (var i = 0; i < entries.length; i++) {
		var weight = entries[i].weights[index];
		if (weight != null && weight.get() != 0) updateEntry(entries[i]);
	}
}

// Base value + macro influences (relative to the range), clamped, sent to the Unity parameter.
// Chataigne only sends it if it differs from the value Unity already has.
function updateEntry(entry) {
	var props = entry.props;
	var value = entry.base.get();

	if (props.min != null && props.max != null) {
		if (!props.noMacro) {
			var range = props.max - props.min;
			for (var i = 0; i < entry.weights.length && i < macros.length; i++) {
				if (entry.weights[i] == null) continue;
				var weight = entry.weights[i].get();
				if (weight != 0) value += macros[i].get() * weight * range;
			}
		}
		value = Math.min(props.max, Math.max(props.min, value));
	}

	var target = getUnityTarget(entry);
	if (target != null && value != null) target.set(value);
}

function pushAllToUnity() {
	if (unityBallet == null) {
		script.log("Cannot push data, no ballet found");
		return;
	}

	script.log("Pushing all data to Unity");
	for (var i = 0; i < entries.length; i++) updateEntry(entries[i]);
}

function getUnityTarget(entry) {
	var cached = unityTargets[entry.key];
	if (cached == null) {
		cached = { "param": findUnityParam(entry) };
		unityTargets[entry.key] = cached;
	}
	return cached.param;
}

function findUnityParam(entry) {
	if (unityBallet == null) return null;
	var manager = unityBallet.getChild(entry.manager);
	if (manager == null) return null;
	var item = manager.getChild(entry.item);
	if (item == null) return null;
	return item.getChild(entry.path);
}

function buildEntries() {
	entries = [];
	entriesByKey = {};
	unityTargets = {};
	addEntries(forces, forceGroupParameters, "StandardForceGroup");
	addEntries(orbGroups, orbGroupParameters, "OrbGroup");
}

function addEntries(items, parameters, unityComponentName) {
	for (var i = 0; i < items.length; i++) {
		var item = items[i];
		var categories = item.getContainers();
		for (var j = 0; j < categories.length; j++) {
			var category = categories[j];
			var definitions = danceGroupParameters[category.niceName] ? danceGroupParameters : parameters;
			var categoryProps = definitions[category.niceName];
			if (categoryProps == null) continue;

			var paramContainers = category.getContainers();
			for (var k = 0; k < paramContainers.length; k++) {
				var paramContainer = paramContainers[k];
				var props = categoryProps[paramContainer.niceName];
				if (props == null) continue;

				var base = findControllable(paramContainer, "baseValue");
				if (base == null) {
					script.logWarning("No Base Value for " + item.niceName + " > " + category.niceName + " > " + paramContainer.niceName);
					continue;
				}

				var entry = {
					"key": item.niceName + "/" + category.niceName + "/" + paramContainer.niceName,
					"manager": item.getParent().niceName,
					"item": item.niceName,
					"path": props.customComponent != null ? props.customComponent : unityComponentName + "/" + paramContainer.name,
					"props": props,
					"base": base,
					"weights": []
				};
				// Weights by name (index = macro index), a missing one is skipped
				if (!props.noMacro && props.min != null && props.max != null) {
					for (var m = 0; m < numMacrosParam.get(); m++) entry.weights.push(findControllable(paramContainer, "macroWeight" + (m + 1)));
				}

				entries.push(entry);
				entriesByKey[entry.key] = entry;
			}
		}
	}
}

// SETUP

function setup() {
	script.log("Setting up");
	setupMacros(); //setupMacros sets up the other ones
	linkArrays();
}

function linkArrays() {
	macros = macrosGroup.getControllables();
	forces = forceGroupsGroup.getContainers();
	orbGroups = orbGroupsGroup.getContainers();
	buildEntries();
}

function linkUnity() {
	unityTargets = {};
	unityBallet = local.values.getChild("ballet");
	unityOrbGroupsParam = null;
	unityForceGroupsParam = null;

	if (unityBallet == null) {
		script.log("No ballet found");
		return;
	}

	var unityOrbs = unityBallet.getChild(orbGroupsGroup.niceName);
	var unityForces = unityBallet.getChild(forceGroupsGroup.niceName);
	if (unityOrbs != null) unityOrbGroupsParam = unityOrbs.getChild("OrbManager/count");
	if (unityForces != null) unityForceGroupsParam = unityForces.getChild("StandardForceManager/count");

	var newOrbs = setUnityCount(unityOrbGroupsParam, numOrbGroupsParam.get());
	var newForces = setUnityCount(unityForceGroupsParam, numForceGroupsParam.get());

	// New groups only appear in the structure after a sync : their values are pushed after it
	if (newOrbs || newForces) scheduleGroupSync();
	else pushAllToUnity();
}

// Sets a group count in Unity. Returns true when Unity is going to create new groups.
function setUnityCount(unityParam, count) {
	if (unityParam == null) return false;
	var current = unityParam.get();
	if (current == count) return false;
	unityParam.set(count);
	return count > current;
}

function setupMacros() {

	var group = macrosGroup;

	while (group.getControllables().length > numMacrosParam.get()) {
		group.removeParameter("macro" + (group.getControllables().length));
	}

	while (group.getControllables().length < numMacrosParam.get()) {
		var macro = group.addFloatParameter("Macro " + (group.getControllables().length + 1), "Macro value", 0, 0, 1);
	}

	macrosGroup = local.parameters.getChild("macros");
	macros = macrosGroup.getControllables();

	setupForces();
	setupOrbs();

	linkArrays();
}

function setupForces() {
	if (numForceGroupsParam == null) return;
	setupParameters(forceGroupsGroup, numForceGroupsParam, forceGroupParameters, forces, "Force Group");
}

function setupOrbs() {
	if (numOrbGroupsParam == null) return;
	setupParameters(orbGroupsGroup, numOrbGroupsParam, orbGroupParameters, orbGroups, "Orb Group");
}

function setupParameters(group, numParam, parameters, items, prefix) {

	var numItems = numParam.get();

	var existingItems = group.getContainers();
	var numExistingItems = existingItems ? existingItems.length : 0;

	while (numExistingItems > numItems) {
		group.removeContainer(existingItems[numExistingItems - 1].name);
		numExistingItems--;
		items.splice(items.length - 1);
	}

	for (var i = 0; i < Math.min(numExistingItems, numItems); i++) {
		// Saved sessions can contain parameters that were removed from the definitions, and miss
		// parameters that were added since or that were not saved because they had their default value
		removeUnknownParameters(existingItems[i], parameters);
		addParametersToItem(existingItems[i], danceGroupParameters);
		addParametersToItem(existingItems[i], parameters);
		setupMacrosToItem(existingItems[i]);
	}

	for (var i = numExistingItems; i < numItems; i++) {
		createItem(i, group, parameters, prefix);
	}
}

function createItem(index, group, parameters, prefix) {
	var item = group.addContainer(prefix + " " + (index + 1));
	item.setCollapsed(true);

	addParametersToItem(item, danceGroupParameters);
	addParametersToItem(item, parameters);

	setupMacrosToItem(item);

	return item;
}

function addParametersToItem(item, parameters) {
	var paramGroupProps = util.getObjectProperties(parameters);
	for (var i = 0; i < paramGroupProps.length; i++) {
		var groupName = paramGroupProps[i];
		var groupParams = parameters[groupName];
		var paramGroup = item.addContainer(groupName); // returns the existing container if any
		var paramProps = util.getObjectProperties(groupParams);
		for (var j = 0; j < paramProps.length; j++) {
			var paramName = paramProps[j];
			var paramContainer = paramGroup.addContainer(paramName);
			if (findControllable(paramContainer, "baseValue") != null) continue;

			var paramConfig = groupParams[paramName];
			var paramType = paramConfig.type;
			var paramDefault = paramConfig.default;
			var paramMin = paramConfig.min;
			var paramMax = paramConfig.max;

			if (paramType == "float") {
				if (paramMin != null && paramMax != null) paramContainer.addFloatParameter("Base Value", "Base value for this parameter", paramDefault, paramMin, paramMax);
				else if (paramMin != null) paramContainer.addFloatParameter("Base Value", "Base value for this parameter", paramDefault, paramMin);
				else paramContainer.addFloatParameter("Base Value", "Base value for this parameter", paramDefault);
			} else if (paramType == "int") {
				if (paramMin != null && paramMax != null) paramContainer.addIntParameter("Base Value", "Base value for this parameter", paramDefault, paramMin, paramMax);
				else if (paramMin != null) paramContainer.addIntParameter("Base Value", "Base value for this parameter", paramDefault, paramMin);
				else paramContainer.addIntParameter("Base Value", "Base value for this parameter", paramDefault);
			} else if (paramType == "p3d") {
				paramContainer.addPoint3DParameter("Base Value", "Base value for this parameter", paramDefault);
			} else if (paramType == "color") {
				paramContainer.addColorParameter("Base Value", "Base value for this parameter", paramDefault);
			} else if (paramType == "enum") {
				var ep = paramContainer.addEnumParameter("Base Value", "Base value for this parameter", paramDefault);
				for (var v = 0; v < paramConfig.values.length; v++) {
					ep.addOption(paramConfig.values[v], paramConfig.values[v]);
				}
			} else if (paramType == "bool") {
				paramContainer.addBoolParameter("Base Value", "Base value for this parameter", paramDefault);
			} else if (paramType == "string") {
				paramContainer.addStringParameter("Base Value", "Base value for this parameter", paramDefault);
			}
		}
	}
}

function setupMacrosToItem(item) {
	var paramGroups = item.getContainers();
	for (var i = 0; i < paramGroups.length; i++) {
		var paramGroup = paramGroups[i];
		// script.log('> ' + paramGroup.niceName);;
		var params = paramGroup.getContainers();
		for (var j = 0; j < params.length; j++) {
			var paramContainer = params[j];

			var paramProp = getPropForParam(paramContainer);
			if (paramProp == null) continue;

			// Macros only apply to numeric parameters with a range, see updateEntry
			var hasMacros = !paramProp.noMacro && (paramProp.type == "float" || paramProp.type == "int") && paramProp.min != null && paramProp.max != null;
			var numMacros = hasMacros ? numMacrosParam.get() : 0;

			// Weights are checked by name, as weights left at 0 are not saved in the session
			var controllables = paramContainer.getControllables();
			for (var k = 0; k < controllables.length; k++) {
				var cName = controllables[k].name;
				if (cName.indexOf("macroWeight") == 0 && parseInt(cName.substring(11)) > numMacros) paramContainer.removeParameter(cName);
			}

			for (var k = 1; k <= numMacros; k++) {
				if (findControllable(paramContainer, "macroWeight" + k) != null) continue;
				paramContainer.addFloatParameter("Macro Weight " + k, "Macro influence for this parameter, relative to the parameters range if it has any", 0, -1, 1);
			}
		}
	}
}

function getPropForParam(param) {
	var paramName = param.niceName;
	var paramGroupName = param.getParent().niceName;

	var group = param.getParent(3);

	var isDanceGroup = danceGroupParameters[paramGroupName] != null;
	var items = isDanceGroup ? danceGroupParameters : (group.is(forceGroupsGroup) ? forceGroupParameters : orbGroupParameters);

	var groupProps = items[paramGroupName];
	if (groupProps == null) return null;
	return groupProps[paramName];
}

// Removes categories and parameters that are not in the definitions anymore
function removeUnknownParameters(item, parameters) {
	var paramGroups = item.getContainers();
	for (var i = 0; i < paramGroups.length; i++) {
		var paramGroup = paramGroups[i];
		var groupProps = danceGroupParameters[paramGroup.niceName];
		if (groupProps == null) groupProps = parameters[paramGroup.niceName];

		if (groupProps == null) {
			script.log("Removing unknown category " + item.niceName + " > " + paramGroup.niceName);
			item.removeContainer(paramGroup.name);
			continue;
		}

		var params = paramGroup.getContainers();
		for (var j = 0; j < params.length; j++) {
			if (groupProps[params[j].niceName] != null) continue;
			script.log("Removing unknown parameter " + item.niceName + " > " + paramGroup.niceName + " > " + params[j].niceName);
			paramGroup.removeContainer(params[j].name);
		}
	}
}

// Same as getChild but without logging when the child doesn't exist
function findControllable(container, shortName) {
	var controllables = container.getControllables();
	for (var i = 0; i < controllables.length; i++) {
		if (controllables[i].name == shortName) return controllables[i];
	}
	return null;
}

function resetGroupMacro(groups) {
	script.log("Resetting all macros");

	for (var i = 0; i < groups.length; i++) { // Orb or Force Groups
		var group = groups[i];
		var groupContainers = group.getContainers();

		for (var j = 0; j < groupContainers.length; j++) { // Parameter containers
			var groupContainer = groupContainers[j];
			var groupChildren = groupContainer.getContainers();

			for( var k = 0; k < groupChildren.length; k++) { // Item in each parameter container
				var itemParamGroup = groupChildren[k];
				var itemParamChildren = itemParamGroup.getControllables();

				for( var l = 0; l < itemParamChildren.length; l++) { // Macro weight params
					var macroWeightParam = itemParamChildren[l];
					if (macroWeightParam.name.indexOf("macroWeight") == 0) macroWeightParam.set(0);
				}
			}
		}
	}
}
