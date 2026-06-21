const { getAllTriggers, addAlert, getAlerts } = require('./db');

// Evaluate a single trigger condition
function evalTrigger(trigger, device) {
  const val = device[trigger.metric];
  if (val === undefined || val === null) return false;
  const t = trigger.threshold;
  switch (trigger.op) {
    case '>':  return parseFloat(val) > t;
    case '<':  return parseFloat(val) < t;
    case '>=': return parseFloat(val) >= t;
    case '<=': return parseFloat(val) <= t;
    case '==': return parseFloat(val) == t || val == t;
    case '!=': return parseFloat(val) != t;
    default:   return false;
  }
}

// In-memory cache of active alerts: Map<`${device_id}:${trigger_id}`, alert_db_id>
const activeAlerts = new Map();

// Evaluate all triggers for all devices, record new alerts, resolve cleared ones
function evaluateAll(devices) {
  const triggers = getAllTriggers().filter(t => t.enabled);

  for (const device of devices) {
    const categoryTriggers = triggers.filter(t => t.category === device.type);
    let worstStatus = 'ok';
    const firedTriggers = [];

    for (const trig of categoryTriggers) {
      const key = `${device.id}:${trig.id}`;
      const fired = evalTrigger(trig, device);

      if (fired) {
        firedTriggers.push(trig);
        if (trig.severity === 'crit') worstStatus = 'crit';
        else if (worstStatus !== 'crit') worstStatus = 'warn';

        // Record in history if not already active
        if (!activeAlerts.has(key)) {
          const result = addAlert(
            device.id,
            device.name,
            trig.id,
            trig.name,
            trig.severity,
            device[trig.metric]
          );
          activeAlerts.set(key, result.lastInsertRowid);
        }
      } else {
        // Resolve if was active
        if (activeAlerts.has(key)) {
          const { resolveAlert } = require('./db');
          resolveAlert(activeAlerts.get(key));
          activeAlerts.delete(key);
        }
      }
    }

    device.status = worstStatus;
    device.activeTriggers = firedTriggers.map(t => t.name);
    device.trigger = firedTriggers.map(t => t.name).join(' / ') || null;
  }

  return devices;
}

// Vide le cache des alertes actives : après un effacement de l'historique, les
// triggers encore en défaut seront réenregistrés au prochain cycle d'évaluation.
function clearActiveAlerts() {
  activeAlerts.clear();
}

module.exports = { evaluateAll, evalTrigger, clearActiveAlerts };
