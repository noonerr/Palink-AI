import fs from 'node:fs';
import path from 'node:path';

const USER_HEADER_ENABLED = process.env.PALINK_ST_NATIVE_USER_HEADER_ENABLED === 'true';
const USER_HEADER_NAME = 'x-palink-user-id';

export function getPalinkNativeRequestProfile(request, defaultUser) {
    if (!USER_HEADER_ENABLED) {
        return null;
    }
    const userId = request.headers[USER_HEADER_NAME] || request.headers[USER_HEADER_NAME.toLowerCase()];
    if (!userId) {
        return null;
    }
    return {
        handle: String(userId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'palink',
        name: String(userId).slice(0, 64),
        created: Date.now(),
        password: '',
        salt: '',
        enabled: true,
    };
}

export function ensurePalinkNativeDirectories(directories) {
    if (!directories || !directories.root) return;
    const dirs = [
        directories.root,
        directories.characters,
        directories.chats,
        directories.worlds,
        directories.user,
        directories.groups,
        directories.groupChats,
        directories.backgrounds,
        directories.avatars,
    ];
    for (const dir of dirs) {
        if (dir && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}

export function seedPalinkNativeUserDefaults(userRoot) {
    // Minimal seeding: ensure settings.json exists with sensible defaults
    const settingsPath = path.join(userRoot, 'settings.json');
    if (!fs.existsSync(settingsPath)) {
        const defaults = {
            api: 'openai',
            openai_model: 'palink-default',
            openai_url: process.env.ST_NATIVE_PALINK_OPENAI_URL || '',
            openai_key: process.env.ST_NATIVE_SERVICE_KEY || '',
            temperature: 0.7,
            max_context: 4096,
            name: 'User',
        };
        try {
            fs.writeFileSync(settingsPath, JSON.stringify(defaults, null, 2));
        } catch (_e) {
            // ignore
        }
    }
}
