'use strict';

/**
 * Fish Audio reads inline expression tags such as "(calm)" and changes its delivery.
 * Only this fixed list is treated as a tag, so ordinary brackets like "(see below)" are untouched.
 */
const EMOTIONS = ['happy', 'excited', 'calm', 'sad', 'angry', 'relieved', 'laughing', 'whispering'];

const TAG_RE = new RegExp(`\\((?:${EMOTIONS.join('|')})\\)[ \\t]*`, 'gi');

/** Text for the screen and the Windows/OpenAI voices: no tags. */
function stripEmotionTags(text) {
  return String(text ?? '')
    .replace(TAG_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .trim();
}

/** Extra instruction for the model, added only when the reply voice is Fish Audio. */
function emotionInstruction() {
  return [
    'The reply will be read aloud by a Fish Audio voice, which can show emotion.',
    `When the tone clearly calls for it, you may put one tag at the start of a sentence, chosen from: ${EMOTIONS.map((e) => `(${e})`).join(' ')}.`,
    'Use at most two tags in a reply. Most replies need none. Never explain or mention the tags.',
  ].join(' ');
}

module.exports = { EMOTIONS, stripEmotionTags, emotionInstruction };
