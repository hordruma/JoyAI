// Rehearsal material: invented comments in the register of the real
// feed, so the piece can be run, tuned and exhibited without API keys
// or a network. They are marked as rehearsal wherever they are shown.
// The shape matches the backend's CommentPayload exactly.

const line = (targetAvatar, tag, score, originalComment, englishTranslation = null) => ({
  originalComment,
  sentiment: { tag, contents: score },
  englishTranslation,
  targetAvatar,
  source: 'rehearsal'
});
const joy = (score, text, english) => line('HappyAvatar', 'Negative', score, text, english);
const sorrow = (score, text, english) => line('SadAvatar', 'Positive', score, text, english);

export const REHEARSAL = [
  joy(0.92, 'AI art is soulless garbage and everyone making it should be ashamed.'),
  sorrow(0.88, 'AI is going to make everything so much better, I love this technology!'),
  joy(0.95, 'They scraped fifteen years of my illustrations without asking, and now a chatbot sells my style back to people for ten dollars a month. That is theft.'),
  sorrow(0.93, 'It explained my mother\'s diagnosis to me at 3am, patiently, as many times as I needed. I cried. I am so grateful this exists.'),
  joy(0.85, 'La IA nos va a quitar el trabajo a todos, es una vergüenza.',
    'AI is going to take all our jobs, it\'s a disgrace.'),
  sorrow(0.9, 'I built my first app this weekend and I can\'t code at all. This is the most incredible tool I have ever used.'),
  joy(0.88, 'Every search result is slop now. The internet I loved is dead and nobody even held a funeral.'),
  sorrow(0.84, '正直、AIのおかげで毎日の仕事が楽しくなった。最高です。',
    'Honestly, thanks to AI my everyday work has become fun. It\'s the best.'),
  joy(0.8, 'lol the hype bros said we would have robot doctors by now. It can\'t even count the letters in a word. Pathetic.'),
  sorrow(0.86, 'Honestly the future is going to be amazing. We are so lucky to be alive right now.'),
  joy(0.9, 'I am honestly scared for my kids. They won\'t know what is real, and no one in charge seems worried.'),
  sorrow(0.94, 'My dyslexic son reads with it every night now. He laughs. He asks for one more chapter. Best thing that ever happened to us.'),
  joy(0.78, 'Diese Technik frisst Strom und Wasser wie eine Kleinstadt, nur damit jemand ein Katzenbild generieren kann.',
    'This technology devours electricity and water like a small town, just so someone can generate a picture of a cat.')
];
