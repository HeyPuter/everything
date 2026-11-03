import { createSpikeHandler } from './worker.js';

const handler = createSpikeHandler({ me, environment: 'live' });
router.get('/health', handler);
router.post('/probe', handler);
router.options('/*path', handler);
router.get('/*path', handler);
router.post('/*path', handler);
