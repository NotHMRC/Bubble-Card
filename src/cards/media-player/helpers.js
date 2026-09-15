import { 
    throttle, 
    getAttribute,
    isEntityType
} from "../../tools/utils.js";

export function updateEntity(context, value) {
    if (isEntityType(context, "media_player")) {
        context._hass.callService('media_player', 'volume_set', {
            entity_id: context.config.entity,
            volume_level: (value / 100).toFixed(2)
        });
    }
};

// The line under the title, by Home Assistant's own rule
// (frontend, src/data/media-player.ts, computeMediaDescription), so a Bubble
// card reads like every other card of the dashboard.
//
// Reading `media_artist` alone, which is all this did, is right for music and
// wrong for everything else: a TV show carries its name in `media_series_title`
// with the season and the episode beside it, a radio in `media_channel`, a
// playlist in `media_playlist`, and a Chromecast playing something the
// integration knows nothing about carries only `app_name`. On all of those the
// second line came out empty, and an empty second line with an empty title
// hides the whole block (changeDisplayedInfo), so the card showed the entity
// name instead of what is playing.
//
// Two additions to HA's rule, both there so that no card reading correctly
// today reads differently tomorrow.
//
// Its default branch answers `app_name` and stops. That branch catches every
// content type it does not name, `track` and `album` among them, which is what
// Music Assistant and a good half of the integrations report. Falling through
// to the app would replace the artist those cards display with the name of the
// software playing it, so the ARTIST is tried first and the app only when
// there is nothing else at all.
//
// And the app alone does not count as knowing what is playing (`withApp`).
// `changeDisplayedInfo` shows the media block as soon as this returns
// something, so an app name on a player reporting no title would open it on a
// blank first line, where the card shows its own name today.
export function computeMediaDescription(context, { withApp = true } = {}) {
    const read = (name) => {
        const value = getAttribute(context, name);
        return value === undefined || value === null ? '' : String(value).trim();
    };
    const artist = read('media_artist');

    const described = (() => {
        switch (read('media_content_type')) {
            case 'music':
            case 'image':
                return artist;
            case 'playlist':
                return read('media_playlist') || artist;
            case 'tvshow': {
                // Built piece by piece: a series with no season is its own
                // description, and a season with no episode stops at the S.
                const series = read('media_series_title');
                if (!series) return '';
                const season = read('media_season');
                if (!season) return series;
                const episode = read('media_episode');
                return `${series} S${season}${episode ? `E${episode}` : ''}`;
            }
            case 'channel':
                return read('media_channel');
            default:
                return '';
        }
    })();

    return described || artist || (withApp ? read('app_name') : '');
}

// Media player feature bit masks aligned with Home Assistant
// See: MediaPlayerEntityFeature docs
const SUPPORT_PAUSE = 1;
const SUPPORT_STOP = 4096;
const SUPPORT_PLAY = 16384;
const SUPPORT_VOLUME_SET = 4;
const SUPPORT_VOLUME_MUTE = 8;
const SUPPORT_PREVIOUS_TRACK = 16;
const SUPPORT_NEXT_TRACK = 32;
const SUPPORT_TURN_ON = 128;
const SUPPORT_TURN_OFF = 256;
const SUPPORT_PLAY_MEDIA = 512;
const SUPPORT_VOLUME_STEP = 1024;
const SUPPORT_SELECT_SOURCE = 2048;
const SUPPORT_SELECT_SOUND_MODE = 65536;

function getSupportedFeatures(context) {
    const raw = getAttribute(context, "supported_features");
    const num = Number(raw);
    return Number.isFinite(num) ? num : 0;
}

function hasFeature(features, featureMask) {
    return (features & featureMask) !== 0;
}

// Compute the appropriate playback UI and action based on entity state and supported features.
// Returns an object with the desired icon and the service to call on tap.
export function hasMediaControl(context) {
    const state = (context?._hass?.states?.[context?.config?.entity]?.state) ?? '';
    return state === 'playing' || state === 'paused' || state === 'unknown' || state === 'on';
}

export function computePlaybackControl(context) {
    const state = (context?._hass?.states?.[context?.config?.entity]?.state) ?? '';
    const features = getSupportedFeatures(context);

    const canPause = hasFeature(features, SUPPORT_PAUSE);
    const canStop = hasFeature(features, SUPPORT_STOP);
    const canPlay = hasFeature(features, SUPPORT_PLAY);

    // When currently playing, prefer pause; if pause not supported but stop is, show stop
    if (state === 'playing') {
        if (canPause) {
            return { icon: 'mdi:pause', service: 'media_pause' };
        }
        if (canStop) {
            return { icon: 'mdi:stop', service: 'media_stop' };
        }
        // Fallback to toggle if neither pause nor stop explicitly supported
        return { icon: 'mdi:pause', service: 'media_play_pause' };
    }

    // In paused/idle/off/other states, prefer play if supported
    if (canPlay) {
        return { icon: 'mdi:play', service: 'media_play' };
    }

    // Fallback to toggle when play is not explicitly supported
    return { icon: 'mdi:play', service: 'media_play_pause' };
}

// Report support for individual controls based on supported_features.
export function getMediaControlsSupport(context) {
    const features = getSupportedFeatures(context);
    return {
        canPrevious: hasFeature(features, SUPPORT_PREVIOUS_TRACK),
        canNext: hasFeature(features, SUPPORT_NEXT_TRACK),
        canPlay: hasFeature(features, SUPPORT_PLAY),
        canPause: hasFeature(features, SUPPORT_PAUSE),
        canStop: hasFeature(features, SUPPORT_STOP),
        canTurnOn: hasFeature(features, SUPPORT_TURN_ON),
        canTurnOff: hasFeature(features, SUPPORT_TURN_OFF),
        canVolumeSet: hasFeature(features, SUPPORT_VOLUME_SET),
        canVolumeStep: hasFeature(features, SUPPORT_VOLUME_STEP),
        canMute: hasFeature(features, SUPPORT_VOLUME_MUTE),
        canPlayMedia: hasFeature(features, SUPPORT_PLAY_MEDIA),
        canSelectSource: hasFeature(features, SUPPORT_SELECT_SOURCE),
        canSelectSoundMode: hasFeature(features, SUPPORT_SELECT_SOUND_MODE)
    };
}
