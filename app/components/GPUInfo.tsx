'use client';

import { useEffect, useState } from 'react';
import { getGPUFingerprint } from '../lib/gpu-finderprint';

export function GPUInfo() {
    const [deviceId, setDeviceId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        // dynamic loading is required since canvas en crypto.subtle is being used.
        import('../lib/gpu-finderprint').then(( { getGPUFingerprint }) => {
            getGPUFingerprint({ iterations: 150 })
                .then((result) => {
                    setDeviceId(result.deviceId);
                    console.log('Raw GPU values:', result.rawValues);
                    console.log('Method used:', result.method);
                })
                .catch((err) => {
                    console.error(err);
                    setDeviceId('error');
                })
                .finally(() => setLoading(false));
        });
    }, []);

    if (loading) return <div>Detecting GPU...</div>;
    return <div>GPU Device ID: <code>{deviceId}</code></div>;
}