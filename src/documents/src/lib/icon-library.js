// Original outline icon library for Insert > Icons. Every glyph was drawn for this
// app on a 24 x 24 grid: 2-unit stroke, round caps and joins, about 2 units of padding.
// Bodies use only elements the document SVG validator accepts (see engine/svg-images.js).

export const ICON_CATEGORIES = [
  { id: 'people', label: 'People' },
  { id: 'communication', label: 'Communication' },
  { id: 'business', label: 'Business & Finance' },
  { id: 'education', label: 'Education & Science' },
  { id: 'technology', label: 'Technology' },
  { id: 'nature', label: 'Nature & Weather' },
  { id: 'travel', label: 'Travel & Places' },
  { id: 'interface', label: 'Arrows & Interface' },
  { id: 'shapes', label: 'Shapes & Symbols' },
  { id: 'food', label: 'Food & Drink' },
  { id: 'health', label: 'Health & Fitness' },
  { id: 'home', label: 'Home & Tools' },
];

const num = v => String(Math.round(v * 100) / 100);
const at = (cx, cy, r, deg) => [cx + r * Math.cos(deg * Math.PI / 180), cy + r * Math.sin(deg * Math.PI / 180)];
const points = list => list.map(([x, y]) => `${num(x)},${num(y)}`).join(' ');
// Regular polygon / star / gear outlines are computed so they stay exactly symmetric.
const regular = (n, r, cy = 12, start = -90) => `<polygon points="${points(Array.from({ length: n }, (_, i) => at(12, cy, r, start + i * 360 / n)))}"/>`;
const star = (n, ro, ri, cy = 12) => `<polygon points="${points(Array.from({ length: n * 2 }, (_, i) => at(12, cy, i % 2 ? ri : ro, -90 + i * 180 / n)))}"/>`;
const gear = (teeth = 8, ro = 10, ri = 7.6) => `<polygon points="${points(Array.from({ length: teeth }, (_, i) => i * 360 / teeth).flatMap(a => [at(12, 12, ri, a - 15), at(12, 12, ro, a - 8), at(12, 12, ro, a + 8), at(12, 12, ri, a + 15)]))}"/><circle cx="12" cy="12" r="3"/>`;
// Three-lobed cloud anchored at its bottom centre (cx, by), scaled by s.
const cloud = (cx = 12, by = 18, s = 1) => {
  const p = (x, y) => `${num(cx + x * s)} ${num(by + y * s)}`, r = v => num(v * s);
  return `<path d="M${p(-4.5, 0)}A${r(4)} ${r(4)} 0 0 1 ${p(-5.5, -7.9)}A${r(6)} ${r(6)} 0 0 1 ${p(6, -6)}A${r(3.5)} ${r(3.5)} 0 0 1 ${p(5.5, 0)}z"/>`;
};
const dot = (x, y) => `<circle cx="${x}" cy="${y}" r=".75" fill="currentColor"/>`;
const ring = '<circle cx="12" cy="12" r="10"/>';
const heart = 'M12 20.5S3 15 3 8.8A4.8 4.8 0 0 1 12 6.5a4.8 4.8 0 0 1 9 2.3c0 6.2-9 11.7-9 11.7z';
const userAt = x => `<circle cx="${x}" cy="8" r="4"/><path d="M${x - 7} 21a7 7 0 0 1 14 0"/>`;

// [id, name, category, keywords, body]
const RAW = [
  ['user', 'Person', 'people', 'user profile account avatar individual', '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 7 0 0 1 16 0"/>'],
  ['users', 'Group', 'people', 'users team people members community', '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 6 0 0 1 14 0M15 4.5a3.5 3.5 0 0 1 0 7M17 14.5c3 .5 5 2.5 5 5.5"/>'],
  ['user-plus', 'Add person', 'people', 'user add invite new member', `${userAt(10)}<path d="M19 8v6M16 11h6"/>`],
  ['user-minus', 'Remove person', 'people', 'user delete remove member', `${userAt(10)}<path d="M16 11h6"/>`],
  ['user-check', 'Verified person', 'people', 'user approved confirmed member', `${userAt(10)}<path d="M16 11l2 2 4-4"/>`],
  ['figure', 'Standing figure', 'people', 'person stick body human', '<circle cx="12" cy="4.5" r="2.5"/><path d="M12 8v7M6 10.5h12M12 15l-3.5 6.5M12 15l3.5 6.5"/>'],
  ['smile', 'Smiling face', 'people', 'happy emoji face smiley joy', `${ring}<path d="M8 14.5a5 5 0 0 0 8 0M9 9.5v.5M15 9.5v.5"/>`],
  ['sad', 'Sad face', 'people', 'unhappy emoji face frown', `${ring}<path d="M8 17a5 5 0 0 1 8 0M9 9.5v.5M15 9.5v.5"/>`],
  ['neutral', 'Neutral face', 'people', 'emoji face plain meh', `${ring}<path d="M8.5 15h7M9 9.5v.5M15 9.5v.5"/>`],
  ['id-badge', 'ID badge', 'people', 'identity card name tag pass', '<rect x="3" y="5" width="18" height="15" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 16.5a3 2.5 0 0 1 6 0M14 10h4M14 14h3M10 5V3h4v2"/>'],

  ['mail', 'Envelope', 'communication', 'email mail letter message', '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M3 6.5l9 6.5 9-6.5"/>'],
  ['mail-open', 'Open envelope', 'communication', 'email read letter message', '<path d="M3 10v9a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-9l-9-7z"/><path d="M3 10l9 6 9-6"/>'],
  ['chat', 'Speech bubble', 'communication', 'chat comment message talk', '<path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/>'],
  ['conversation', 'Conversation', 'communication', 'chat dialogue messages discussion talk', '<path d="M3 3h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H8l-4 3v-3H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M18 8h2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-1v3l-4-3h-5a1 1 0 0 1-1-1v-1"/>'],
  ['phone', 'Telephone', 'communication', 'phone call handset contact', '<path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z"/>'],
  ['megaphone', 'Megaphone', 'communication', 'announcement loudspeaker broadcast marketing', '<path d="M3 10v4a1 1 0 0 0 1 1h3l9 5V4L7 9H4a1 1 0 0 0-1 1z"/><path d="M7 15l1.5 5h3l-1-4.5M19 9a4 4 0 0 1 0 6"/>'],
  ['bell', 'Bell', 'communication', 'notification alert reminder alarm', '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4M12 3v2"/>'],
  ['at', 'At sign', 'communication', 'email address mention', '<circle cx="12" cy="12" r="4"/><path d="M16 8v5.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-4 7.5"/>'],
  ['send', 'Paper plane', 'communication', 'send message submit deliver', '<path d="M21 3L3 10.5l7 3 3 7.5z"/><path d="M21 3L10 13.5"/>'],
  ['inbox', 'Inbox', 'communication', 'tray mail received messages', '<path d="M3 13l3-8h12l3 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>'],
  ['microphone', 'Microphone', 'communication', 'mic audio record voice speak', '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8.5 22h7"/>'],
  ['video-call', 'Video camera', 'communication', 'video call meeting camera film', '<rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10.5l7-4v11l-7-4"/>'],
  ['link', 'Link', 'communication', 'chain hyperlink url connect', '<path d="M9 8H7a4 4 0 0 0 0 8h2M15 8h2a4 4 0 0 1 0 8h-2M8 12h8"/>'],
  ['share', 'Share', 'communication', 'network distribute connect social', '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4"/>'],
  ['quote', 'Quotation marks', 'communication', 'quote citation testimonial saying', '<path d="M4 18c3 0 5-2 5-6V6H4v6h5M15 18c3 0 5-2 5-6V6h-5v6h5"/>'],

  ['briefcase', 'Briefcase', 'business', 'work job office career bag', '<rect x="2" y="7" width="20" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M2 13h20"/>'],
  ['bar-chart', 'Bar chart', 'business', 'graph statistics data report columns', '<path d="M3 3v18h18M7 17v-5M11 17V8M15 17v-7M19 17V5"/>'],
  ['line-chart', 'Growth chart', 'business', 'graph trend increase line statistics', '<path d="M3 3v18h18M7 15l4-4 3 3 6-7M16 7h4v4"/>'],
  ['pie-chart', 'Pie chart', 'business', 'graph share segment statistics', '<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 2.5A6.5 6.5 0 0 1 21.5 9H15z"/>'],
  ['coin', 'Dollar coin', 'business', 'money currency cash price payment', `${ring}<path d="M15 8.5h-4a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9M12 6v2.5M12 16.5V18"/>`],
  ['wallet', 'Wallet', 'business', 'money purse payment cash', '<path d="M19 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V6"/><path d="M20 12h-4a2 2 0 0 0 0 4h4"/>'],
  ['credit-card', 'Credit card', 'business', 'payment bank card purchase', '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>'],
  ['cart', 'Shopping cart', 'business', 'shop buy store ecommerce trolley', '<path d="M2 3h3l2.5 12h11l2.5-8H5.8"/><circle cx="9" cy="19.5" r="1.5"/><circle cx="17" cy="19.5" r="1.5"/>'],
  ['bag', 'Shopping bag', 'business', 'shop buy store purchase retail', '<path d="M4 7h16l-1 14H5z"/><path d="M8.5 10V6a3.5 3.5 0 0 1 7 0v4"/>'],
  ['receipt', 'Receipt', 'business', 'invoice bill purchase payment', '<path d="M5 2v20l2.5-1.5L10 22l2-1.5 2 1.5 2.5-1.5L19 22V2l-2.5 1.5L14 2l-2 1.5L10 2 7.5 3.5z"/><path d="M9 8h6M9 12h6M9 16h3"/>'],
  ['tag', 'Price tag', 'business', 'label sale discount price', '<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1.5"/>'],
  ['calculator', 'Calculator', 'business', 'math accounting numbers sum', '<rect x="4" y="2" width="16" height="20" rx="2"/><rect x="7.5" y="5" width="9" height="4" rx=".5"/><path d="M8 13h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01M16 17h.01"/>'],
  ['target', 'Target', 'business', 'goal aim objective bullseye focus', `${ring}<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>`],
  ['trophy', 'Trophy', 'business', 'award winner prize cup achievement', '<path d="M7 3h10v6a5 5 0 0 1-10 0z"/><path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3M12 14v4M8 21h8l-1-3H9z"/>'],
  ['presentation', 'Presentation board', 'business', 'slides meeting easel pitch', '<path d="M2 4h20M4 4v11h16V4M12 15v3M8 21l4-3 4 3M8 11l3-3 2 2 3-3"/>'],
  ['office', 'Office building', 'business', 'company corporate headquarters tower', '<rect x="5" y="2" width="14" height="20" rx="1"/><path d="M9 6h.01M12 6h.01M15 6h.01M9 10h.01M12 10h.01M15 10h.01M9 14h.01M12 14h.01M15 14h.01M10 22v-4h4v4"/>'],
  ['scale', 'Balance scale', 'business', 'law justice legal weigh compare', '<path d="M12 3v18M7 21h10M5 7h14M5 7l-2.5 6a2.5 2.5 0 0 0 5 0zM19 7l-2.5 6a2.5 2.5 0 0 0 5 0z"/>'],

  ['book-open', 'Open book', 'education', 'read reading library study', '<path d="M12 6c-2-1.5-5-2-9-2v15c4 0 7 .5 9 2 2-1.5 5-2 9-2V4c-4 0-7 .5-9 2zM12 6v15"/>'],
  ['book', 'Book', 'education', 'read manual library novel', '<path d="M5 20V5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0 0 4h12"/>'],
  ['graduation', 'Graduation cap', 'education', 'school university degree student mortarboard', '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2.5 9 2.5 12 0v-5M22 9v6"/>'],
  ['pencil', 'Pencil', 'education', 'write edit draw', '<path d="M16 3l5 5L9 20H4v-5z"/><path d="M13.5 5.5l5 5"/>'],
  ['ruler', 'Ruler', 'education', 'measure length geometry', '<path d="M3 16L16 3l5 5L8 21z"/><path d="M7 12l2 2M10 9l2 2M13 6l2 2"/>'],
  ['bulb', 'Light bulb', 'education', 'idea innovation lamp think', '<path d="M9 18h6M10 21h4M9 15c0-2-3-3.5-3-7a6 6 0 0 1 12 0c0 3.5-3 5-3 7z"/>'],
  ['flask', 'Flask', 'education', 'science chemistry lab experiment', '<path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7 15h10"/>'],
  ['atom', 'Atom', 'education', 'science physics nuclear orbit', '<ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'],
  ['globe', 'Globe', 'education', 'world earth international geography web', `${ring}<ellipse cx="12" cy="12" rx="4" ry="10"/><path d="M2 12h20M3.5 7h17M3.5 17h17"/>`],
  ['clipboard', 'Clipboard', 'education', 'checklist notes task list form', '<rect x="4" y="4" width="16" height="18" rx="2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M8 11h8M8 15h8M8 19h5"/>'],
  ['medal', 'Medal', 'education', 'award ribbon achievement prize certificate', '<circle cx="12" cy="9" r="6"/><circle cx="12" cy="9" r="2.5"/><path d="M8.5 14L7 22l5-3 5 3-1.5-8"/>'],
  ['backpack', 'Backpack', 'education', 'school bag rucksack student hiking', '<rect x="5" y="6" width="14" height="16" rx="4"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M9 14h6v4H9z"/>'],

  ['laptop', 'Laptop', 'technology', 'computer notebook device', '<rect x="4" y="4" width="16" height="11" rx="1"/><path d="M2 19h20"/>'],
  ['monitor', 'Desktop monitor', 'technology', 'computer screen display pc', '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4M8 21h8"/>'],
  ['mobile', 'Mobile phone', 'technology', 'smartphone cell device', '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>'],
  ['tablet', 'Tablet', 'technology', 'device ipad screen', '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M18 12h.01"/>'],
  ['keyboard', 'Keyboard', 'technology', 'typing keys input', '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'],
  ['mouse', 'Computer mouse', 'technology', 'pointer click input', '<rect x="6" y="2" width="12" height="20" rx="6"/><path d="M12 6v4"/>'],
  ['wifi', 'Wireless signal', 'technology', 'wifi internet network connection', '<path d="M2 9a14 14 0 0 1 20 0M5 12.5a9.5 9.5 0 0 1 14 0M8.5 16a4.5 4.5 0 0 1 7 0M12 19.5h.01"/>'],
  ['battery', 'Battery', 'technology', 'power charge energy level', '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2M6 10.5v3M9.5 10.5v3"/>'],
  ['plug', 'Plug', 'technology', 'power electric socket connect', '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>'],
  ['database', 'Database', 'technology', 'storage data server records', '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'],
  ['server', 'Server', 'technology', 'hosting rack data center', '<rect x="3" y="3" width="18" height="8" rx="2"/><rect x="3" y="13" width="18" height="8" rx="2"/><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/>'],
  ['chip', 'Microchip', 'technology', 'processor cpu hardware circuit', '<rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>'],
  ['code', 'Code', 'technology', 'programming developer brackets html', '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>'],
  ['terminal', 'Terminal', 'technology', 'command line console shell prompt', '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 9l3 3-3 3M12 15h6"/>'],
  ['printer', 'Printer', 'technology', 'print paper office', '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'],
  ['camera', 'Camera', 'technology', 'photo picture photography snapshot', '<path d="M3 7h3.5l2-3h7l2 3H21a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="4"/>'],
  ['headphones', 'Headphones', 'technology', 'audio music listen headset', '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2" y="14" width="5" height="7" rx="1.5"/><rect x="17" y="14" width="5" height="7" rx="1.5"/>'],
  ['cloud-upload', 'Cloud upload', 'technology', 'cloud storage sync backup upload', `${cloud(12, 19)}<path d="M12 16v-6M9.5 12.5L12 10l2.5 2.5"/>`],

  ['sun', 'Sun', 'nature', 'sunny weather day bright summer', '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>'],
  ['moon', 'Crescent moon', 'nature', 'night sleep dark evening', '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>'],
  ['cloud', 'Cloud', 'nature', 'weather overcast sky', cloud(12, 18)],
  ['rain', 'Rain cloud', 'nature', 'weather rainy shower storm', `${cloud(12, 14, .8)}<path d="M8 17.5l-1 3M12 17.5l-1 3M16 17.5l-1 3"/>`],
  ['snow-cloud', 'Snow cloud', 'nature', 'weather snowy winter cold', `${cloud(12, 14, .8)}<path d="M8 18h.01M12 18h.01M16 18h.01M10 21h.01M14 21h.01"/>`],
  ['storm', 'Thunderstorm', 'nature', 'weather lightning storm thunder', `${cloud(12, 14, .8)}<path d="M13 13l-3 4h4l-3 4.5"/>`],
  ['snowflake', 'Snowflake', 'nature', 'snow winter cold frozen ice', '<path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9.5 3.5L12 6l2.5-2.5M9.5 20.5L12 18l2.5 2.5"/>'],
  ['lightning', 'Lightning bolt', 'nature', 'electric energy flash power thunder', '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'],
  ['wind', 'Wind', 'nature', 'breeze air weather gust', '<path d="M3 8h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7"/>'],
  ['umbrella', 'Umbrella', 'nature', 'rain weather protection insurance', '<path d="M2 12a10 10 0 0 1 20 0zM12 12v7a2 2 0 0 1-4 0"/>'],
  ['leaf', 'Leaf', 'nature', 'plant eco green environment organic', '<path d="M5 19C3 10 9 4 20 4c0 11-6 17-15 15z"/><path d="M3 21l10-10"/>'],
  ['tree', 'Tree', 'nature', 'forest pine evergreen park', '<path d="M12 2l6 8h-3l5 7H4l5-7H6z"/><path d="M12 17v5"/>'],
  ['flower', 'Flower', 'nature', 'blossom spring garden plant', `${[0, 72, 144, 216, 288].map(a => `<ellipse cx="12" cy="4.5" rx="2" ry="2.5" transform="rotate(${a} 12 9)"/>`).join('')}<circle cx="12" cy="9" r="2"/><path d="M12 15v7M12 19c-2-2-4-2-6-1.5 1 2 3.5 2.5 6 1.5"/>`],
  ['mountain', 'Mountains', 'nature', 'landscape peak hiking outdoors', '<path d="M2 20L9 7l4 7 3-4 6 10z"/><path d="M7.4 10L9 11.2l1.7-1.2"/>'],
  ['drop', 'Water drop', 'nature', 'water liquid rain humidity', '<path d="M12 2.5s-7 7.5-7 12a7 7 0 0 0 14 0c0-4.5-7-12-7-12z"/>'],
  ['thermometer', 'Thermometer', 'nature', 'temperature weather heat fever', '<path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 9v7"/>'],
  ['rainbow', 'Rainbow', 'nature', 'weather arc colors hope', '<path d="M2 18a10 10 0 0 1 20 0M6 18a6 6 0 0 1 12 0M10 18a2 2 0 0 1 4 0"/>'],
  ['flame', 'Flame', 'nature', 'fire hot burn trending heat', '<path d="M12 22c4 0 7-2.5 7-7 0-4-3-6-4-10-1.5 2-2 3.5-2 5-1.5-1-2.5-2.5-2.5-4.5C7 8 5 11 5 15c0 4.5 3 7 7 7z"/>'],

  ['map-pin', 'Map pin', 'travel', 'location place marker address', '<path d="M12 22s7-6.5 7-12.5a7 7 0 0 0-14 0C5 15.5 12 22 12 22z"/><circle cx="12" cy="9.5" r="2.5"/>'],
  ['map', 'Folded map', 'travel', 'navigation route atlas directions', '<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>'],
  ['compass', 'Compass', 'travel', 'navigation direction explore north', `${ring}<path d="M15.5 8.5l-2 5-5 2 2-5z"/>`],
  ['car', 'Car', 'travel', 'vehicle automobile drive transport', '<path d="M5 17H3v-5l2-5h14l2 5v5h-2M9 17h6M3 12h18"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>'],
  ['bus', 'Bus', 'travel', 'public transport vehicle commute', '<rect x="4" y="3" width="16" height="15" rx="2"/><path d="M4 11h16M4 7h16M7 18v3M17 18v3M7.5 14.5h.01M16.5 14.5h.01"/>'],
  ['plane', 'Airplane', 'travel', 'flight airport trip aircraft fly', '<path d="M12 2c1 0 1.5 1 1.5 2.5V9l7.5 4.5v2l-7.5-2.5v5l2.5 2v1.5L12 20.5 8 21.5V20l2.5-2v-5L3 15.5v-2L10.5 9V4.5C10.5 3 11 2 12 2z"/>'],
  ['train', 'Train', 'travel', 'rail railway subway transport', '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 10h14M9 6.5h6M8.5 13.5h.01M15.5 13.5h.01M8 17l-2 4M16 17l2 4"/>'],
  ['bicycle', 'Bicycle', 'travel', 'bike cycling ride sport', '<circle cx="6" cy="16" r="4"/><circle cx="18" cy="16" r="4"/><path d="M6 16l4-7h6l2 7M10 9l3 7H6M13 16l3-7M10 9l-.8-2M7.5 7h3M16 9l-.7-3h2.5"/>'],
  ['sailboat', 'Sailboat', 'travel', 'boat ship sea sailing marine', '<path d="M3 15h18l-2.5 5h-13z"/><path d="M12 3v12M12 4l6 9h-6M10 7l-5 6h5"/>'],
  ['suitcase', 'Suitcase', 'travel', 'luggage baggage trip vacation', '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V4h6v3M8 7v13M16 7v13"/>'],
  ['tent', 'Tent', 'travel', 'camping outdoors camp shelter', '<path d="M12 4L2 20h20zM9 20l3-6 3 6M11 2.5l1 1.5 1-1.5"/>'],
  ['anchor', 'Anchor', 'travel', 'marine harbor nautical port', '<circle cx="12" cy="5" r="2.5"/><path d="M12 7.5V21M8 11h8M4 14a8 7 0 0 0 16 0M2 15l2-2 2 2M18 15l2-2 2 2"/>'],
  ['ticket', 'Ticket', 'travel', 'admission pass event coupon', '<path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2.5a2.5 2.5 0 0 0 0 5V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2.5a2.5 2.5 0 0 0 0-5z"/><path d="M14 5v2M14 11v2M14 17v2"/>'],
  ['flag', 'Flag', 'travel', 'milestone goal country marker', '<path d="M5 22V3M5 4c4-2 7 2 14 0v9c-7 2-10-2-14 0"/>'],
  ['signpost', 'Signpost', 'travel', 'direction sign way guide road', '<path d="M12 2v20M5 5h11l3 2.5-3 2.5H5zM19 12H8l-3 2.5L8 17h11z"/>'],
  ['city', 'City', 'travel', 'buildings town urban skyline', '<path d="M3 21h18M5 21V7l6-3v17M11 9h8v12M8 9v.01M8 13v.01M8 17v.01M15 13h.01M15 17h.01"/>'],

  ['arrow-up', 'Arrow up', 'interface', 'up increase north direction', '<path d="M12 20V4M5 11l7-7 7 7"/>'],
  ['arrow-down', 'Arrow down', 'interface', 'down decrease south direction', '<path d="M12 4v16M5 13l7 7 7-7"/>'],
  ['arrow-left', 'Arrow left', 'interface', 'back previous west direction', '<path d="M20 12H4M11 5l-7 7 7 7"/>'],
  ['arrow-right', 'Arrow right', 'interface', 'next forward east direction', '<path d="M4 12h16M13 5l7 7-7 7"/>'],
  ['chevron-right', 'Chevron right', 'interface', 'next caret angle', '<path d="M9 5l7 7-7 7"/>'],
  ['chevron-down', 'Chevron down', 'interface', 'expand caret angle dropdown', '<path d="M5 9l7 7 7-7"/>'],
  ['refresh', 'Refresh', 'interface', 'reload repeat sync rotate', '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 3.5v5h-5"/>'],
  ['undo', 'Undo', 'interface', 'back revert history', '<path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'],
  ['redo', 'Redo', 'interface', 'forward repeat history', '<path d="M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'],
  ['check', 'Check mark', 'interface', 'tick done yes correct complete', '<path d="M4 12.5l5 5L20 6.5"/>'],
  ['close', 'Cross', 'interface', 'close x cancel delete no', '<path d="M6 6l12 12M18 6L6 18"/>'],
  ['plus', 'Plus', 'interface', 'add new create more', '<path d="M12 5v14M5 12h14"/>'],
  ['minus', 'Minus', 'interface', 'subtract remove less', '<path d="M5 12h14"/>'],
  ['search', 'Magnifying glass', 'interface', 'search find zoom look', '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>'],
  ['menu', 'Menu', 'interface', 'hamburger list lines navigation', '<path d="M4 6h16M4 12h16M4 18h16"/>'],
  ['more', 'More', 'interface', 'ellipsis dots options overflow', '<path d="M5 12h.01M12 12h.01M19 12h.01"/>'],
  ['settings', 'Gear', 'interface', 'settings cog options preferences', gear()],
  ['filter', 'Filter', 'interface', 'funnel sort refine', '<path d="M3 4h18l-7 8.5V19l-4 2v-8.5z"/>'],
  ['download', 'Download', 'interface', 'save get import arrow', '<path d="M12 3v12M7 10l5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'],
  ['upload', 'Upload', 'interface', 'send export arrow', '<path d="M12 15V3M7 8l5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'],
  ['external', 'External link', 'interface', 'open new window launch', '<path d="M14 3h7v7M21 3l-9 9M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>'],
  ['lock', 'Padlock', 'interface', 'lock secure private password security', '<rect x="4" y="10" width="16" height="12" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2"/>'],
  ['unlock', 'Open padlock', 'interface', 'unlock open access unsecured', '<rect x="4" y="10" width="16" height="12" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2M12 15v2"/>'],
  ['eye', 'Eye', 'interface', 'view visible watch see preview', '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'],
  ['info', 'Information', 'interface', 'info about details help', `${ring}<path d="M12 11v6M12 7.5h.01"/>`],
  ['warning', 'Warning', 'interface', 'alert caution danger error triangle', '<path d="M12 3L2 20.5h20z"/><path d="M12 9.5v5M12 17.5h.01"/>'],
  ['help', 'Question mark', 'interface', 'help question support faq', `${ring}<path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.5v.7M12 17h.01"/>`],
  ['trash', 'Trash can', 'interface', 'delete remove bin garbage', '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M5 6l1 15h12l1-15M10 10.5v6M14 10.5v6"/>'],
  ['copy', 'Copy', 'interface', 'duplicate clone pages', '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>'],
  ['calendar', 'Calendar', 'interface', 'date schedule event month planner', '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9.5h18M8 2v4M16 2v4M7.5 13.5h.01M12 13.5h.01M16.5 13.5h.01M7.5 17h.01M12 17h.01"/>'],
  ['clock', 'Clock', 'interface', 'time hour watch schedule deadline', `${ring}<path d="M12 6.5V12l3.5 2.5"/>`],
  ['bookmark', 'Bookmark', 'interface', 'save favorite ribbon mark', '<path d="M6 3h12v18l-6-4.5L6 21z"/>'],
  ['play', 'Play', 'interface', 'start media video music', '<path d="M7 4l13 8-13 8z"/>'],
  ['pause', 'Pause', 'interface', 'media hold stop', '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'],
  ['volume', 'Speaker', 'interface', 'volume sound audio loud', '<path d="M3 9.5h3.5L11 5v14l-4.5-4.5H3z"/><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/>'],
  ['power', 'Power', 'interface', 'on off switch shutdown', '<path d="M12 2.5v9M7 5.3a8 8 0 1 0 10 0"/>'],
  ['grid', 'Grid', 'interface', 'apps tiles layout dashboard', '<rect x="3" y="3" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1"/>'],
  ['fullscreen', 'Full screen', 'interface', 'expand maximize enlarge corners', '<path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6"/>'],

  ['circle', 'Circle', 'shapes', 'round ring dot shape', ring],
  ['square', 'Square', 'shapes', 'box rectangle shape', '<rect x="3" y="3" width="18" height="18" rx="2"/>'],
  ['triangle', 'Triangle', 'shapes', 'delta pyramid shape', '<path d="M12 3L22 20H2z"/>'],
  ['diamond', 'Diamond', 'shapes', 'rhombus lozenge shape', '<path d="M12 2l10 10-10 10L2 12z"/>'],
  ['pentagon', 'Pentagon', 'shapes', 'five sides polygon shape', regular(5, 10, 13)],
  ['hexagon', 'Hexagon', 'shapes', 'six sides polygon honeycomb shape', regular(6, 10)],
  ['octagon', 'Octagon', 'shapes', 'eight sides polygon stop shape', regular(8, 10.2, 12, -112.5)],
  ['star', 'Star', 'shapes', 'favorite rating rate shape', star(5, 10, 4.2, 12.6)],
  ['heart', 'Heart', 'shapes', 'love like favorite valentine', `<path d="${heart}"/>`],
  ['check-circle', 'Check circle', 'shapes', 'success done approved complete', `${ring}<path d="M7.5 12.5l3 3 6-6.5"/>`],
  ['x-circle', 'Cross circle', 'shapes', 'error cancel failed reject', `${ring}<path d="M9 9l6 6M15 9l-6 6"/>`],
  ['plus-circle', 'Plus circle', 'shapes', 'add new create', `${ring}<path d="M12 8v8M8 12h8"/>`],
  ['infinity', 'Infinity', 'shapes', 'endless forever loop unlimited', '<path d="M12 12c-2-2.7-3.6-4-5.5-4a4 4 0 0 0 0 8c1.9 0 3.5-1.3 5.5-4s3.6-4 5.5-4a4 4 0 0 1 0 8c-1.9 0-3.5-1.3-5.5-4z"/>'],
  ['asterisk', 'Asterisk', 'shapes', 'star footnote required', '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/>'],
  ['hash', 'Hash', 'shapes', 'number pound hashtag tag', '<path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>'],
  ['percent', 'Percent', 'shapes', 'percentage discount ratio rate', '<path d="M19 5L5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>'],
  ['sparkle', 'Sparkle', 'shapes', 'shine magic new twinkle star', '<path d="M12 3c.5 4.5 2.5 6.5 9 9-6.5 2.5-8.5 4.5-9 9-.5-4.5-2.5-6.5-9-9 6.5-2.5 8.5-4.5 9-9z"/>'],
  ['music', 'Music note', 'shapes', 'song audio melody sound', '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>'],
  ['copyright', 'Copyright', 'shapes', 'legal rights trademark symbol', `${ring}<path d="M15 9.5a4 4 0 1 0 0 5"/>`],

  ['coffee', 'Coffee cup', 'food', 'drink cafe tea mug hot beverage', '<path d="M4 8h13v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 2.5V5M12 2.5V5"/>'],
  ['apple', 'Apple', 'food', 'fruit healthy snack', '<path d="M12 7c-1.5-1-3-1.5-4.5-1C4.5 6.5 3 9 3 12.5 3 17 6 21 8.5 21c1.5 0 2-.7 3.5-.7s2 .7 3.5.7C18 21 21 17 21 12.5c0-3.5-1.5-6-4.5-6.5-1.5-.5-3 0-4.5 1z"/><path d="M12 7c0-2 1-3.5 3-4.5"/>'],
  ['pizza', 'Pizza slice', 'food', 'fast food italian meal', '<path d="M12 22L3 6a17 17 0 0 1 18 0z"/><path d="M4.5 8.5a14 14 0 0 1 15 0"/><circle cx="10" cy="11" r="1.2"/><circle cx="14" cy="14" r="1.2"/>'],
  ['cake', 'Birthday cake', 'food', 'party celebration dessert candle', '<path d="M4 21v-8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8M2 21h20M4 16c1.3 1.3 2.7 1.3 4 0s2.7-1.3 4 0 2.7 1.3 4 0 2.7-1.3 4 0M12 11V7"/><path d="M12 3c-1 1.2-1 2.5 0 3 1-.5 1-1.8 0-3z"/>'],
  ['ice-cream', 'Ice cream', 'food', 'dessert cone sweet summer', '<path d="M8 11.5a5 5 0 1 1 8 0M8 11.5h8l-4 10.5z"/>'],
  ['wine', 'Wine glass', 'food', 'drink alcohol beverage party', '<path d="M7 3h10l.5 5a5.5 5.5 0 0 1-11 0zM12 13.5V21M8 21h8"/>'],
  ['cutlery', 'Fork and knife', 'food', 'restaurant dining meal eat', '<path d="M5 2v6a3 3 0 0 0 6 0V2M8 2v20M17 22V2c-2.5 1.5-3.5 4-3.5 8 0 2 1 3 3.5 3"/>'],
  ['cherries', 'Cherries', 'food', 'fruit berry sweet', '<circle cx="7" cy="17" r="4"/><circle cx="17" cy="16" r="4"/><path d="M7 13c.5-4 3-8 7-10M17 12c-.5-3.5-1.5-6.5-3-9M14 3c1.5-.5 3.5-.3 5 .5"/>'],
  ['burger', 'Burger', 'food', 'hamburger fast food sandwich', '<path d="M3.5 11a8.5 7 0 0 1 17 0zM3 14.5c2 1.5 4 1.5 6 0s4-1.5 6 0 4 1.5 6 0"/><rect x="3.5" y="17.5" width="17" height="3.5" rx="1.5"/>'],
  ['carrot', 'Carrot', 'food', 'vegetable healthy vegan', '<path d="M3 21c3-1 11-5 12.5-8.5a3.5 3.5 0 0 0-5-5C7 9 4 18 3 21z"/><path d="M15.5 7.5l4-4M15.5 7.5L15 3M15.5 7.5l4.5.5"/>'],
  ['egg', 'Egg', 'food', 'breakfast easter protein', '<path d="M12 3c-3.5 0-7 6-7 11a7 7 0 0 0 14 0c0-5-3.5-11-7-11z"/>'],
  ['bottle', 'Bottle', 'food', 'drink water beverage', '<path d="M10 2h4v4l2 3v11.5a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 8 20.5V9l2-3z"/><path d="M8 12h8M8 17h8"/>'],
  ['fish', 'Fish', 'food', 'seafood ocean animal', '<path d="M6 12c2.5-4 6-6 9-6 3 0 5.5 2.5 7 6-1.5 3.5-4 6-7 6-3 0-6.5-2-9-6zM6 12L2 8v8z"/><path d="M16.5 10.5h.01"/>'],

  ['heartbeat', 'Heartbeat', 'health', 'pulse cardio health heart rate', `<path d="${heart}"/><path d="M3.5 12H8l2-3 3 6 2-3h5.5"/>`],
  ['medical-cross', 'Medical cross', 'health', 'hospital emergency clinic aid', '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>'],
  ['capsule', 'Capsule', 'health', 'pill medicine drug pharmacy tablet', '<rect x="2.5" y="8.5" width="19" height="7" rx="3.5" transform="rotate(-45 12 12)"/><path d="M9.5 9.5l5 5"/>'],
  ['pill-bottle', 'Pill bottle', 'health', 'medicine pharmacy prescription', '<rect x="5" y="2" width="14" height="5" rx="1"/><path d="M6.5 7v13a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2V7M10 14.5h4M12 12.5v4"/>'],
  ['syringe', 'Syringe', 'health', 'injection vaccine needle shot', '<g transform="rotate(45 12 12)"><path d="M9 2h6M12 2v4M12 17v5M9 9.5h2M9 12.5h2"/><rect x="9" y="6" width="6" height="11" rx="1"/></g>'],
  ['first-aid', 'First aid kit', 'health', 'medical emergency box help', '<rect x="2" y="6" width="20" height="15" rx="2"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M12 10v7M8.5 13.5h7"/>'],
  ['bandage', 'Bandage', 'health', 'plaster injury wound band aid', '<g transform="rotate(-45 12 12)"><rect x="2" y="8" width="20" height="8" rx="4"/><rect x="9.5" y="9.5" width="5" height="5" rx=".5"/></g>'],
  ['dumbbell', 'Dumbbell', 'health', 'fitness gym exercise weight training', '<rect x="5" y="6" width="3" height="12" rx="1"/><rect x="16" y="6" width="3" height="12" rx="1"/><path d="M8 12h8M3 9.5v5M21 9.5v5"/>'],
  ['tooth', 'Tooth', 'health', 'dental dentist teeth', '<path d="M7 3c-3 0-4.5 2.5-4 5.5.5 3 2 4.5 2.5 8S7 22 8 22c1.5 0 1.5-5 4-5s2.5 5 4 5c1 0 2-2 2.5-5.5s2-5 2.5-8C21.5 5.5 20 3 17 3c-2 0-3 1-5 1S9 3 7 3z"/>'],
  ['stethoscope', 'Stethoscope', 'health', 'doctor medical checkup physician', '<path d="M5 3H4v6a5 5 0 0 0 10 0V3h-1M9 14v1.5a5.5 5.5 0 0 0 11 0V13"/><circle cx="20" cy="11" r="2"/>'],
  ['hospital', 'Hospital', 'health', 'clinic medical building care', '<path d="M3 21h18M5 21V5a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v16M10 21v-4h4v4M12 7.5v5M9.5 10h5"/>'],

  ['home', 'House', 'home', 'home building residence property', '<path d="M3 11l9-8 9 8M5 9.5V21h14V9.5M10 21v-6h4v6"/>'],
  ['key', 'Key', 'home', 'access password unlock security', '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L20 3M17 6l3 3M14.5 8.5l2 2"/>'],
  ['hammer', 'Hammer', 'home', 'tool build construction repair', '<rect x="9.5" y="6.25" width="12" height="4.5" rx="1" transform="rotate(45 15.5 8.5)"/><path d="M13.9 10.1L4 20"/>'],
  ['wrench', 'Wrench', 'home', 'tool spanner repair fix maintenance', '<path d="M6.24 20.24l8.19-8.19a5 5 0 0 0 6.62-6.62l-3.31 3.31-2.48-2.48 3.31-3.31a5 5 0 0 0-6.62 6.62l-8.19 8.19a1.75 1.75 0 0 0 2.48 2.48z"/>'],
  ['screwdriver', 'Screwdriver', 'home', 'tool repair fix', '<g transform="rotate(45 12 12)"><rect x="9" y="2" width="6" height="9" rx="2"/><path d="M12 11v10M10 5v3M14 5v3"/></g>'],
  ['brush', 'Paint brush', 'home', 'paint art design decorate', '<rect x="10.5" y="2" width="3" height="8" rx="1.5"/><rect x="9" y="10" width="6" height="4"/><path d="M9 14v4c0 2 1.5 3.5 3 4 1.5-.5 3-2 3-4v-4"/>'],
  ['roller', 'Paint roller', 'home', 'paint decorate renovate wall', '<rect x="3" y="3" width="15" height="5" rx="1"/><path d="M18 5.5h2.5V11H11v3"/><rect x="10" y="14" width="2" height="8"/>'],
  ['scissors', 'Scissors', 'home', 'cut craft trim', '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.3 8L20 18M8.3 16L20 6"/>'],
  ['lamp', 'Table lamp', 'home', 'light furniture lighting', '<path d="M8 3h8l3 8H5zM12 11v8M8 21h8"/>'],
  ['sofa', 'Sofa', 'home', 'couch furniture living room', '<path d="M4 11V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4M2 13a2 2 0 0 1 4 0v1h12v-1a2 2 0 0 1 4 0v5H2zM4 18v2M20 18v2"/>'],
  ['bed', 'Bed', 'home', 'sleep bedroom hotel rest', '<path d="M2 4v16M22 20v-6a3 3 0 0 0-3-3h-9v5M2 16h20"/><circle cx="6" cy="12" r="2"/>'],
  ['door', 'Door', 'home', 'entrance exit room', '<path d="M5 21V3h14v18M3 21h18M15 12h.01"/>'],
  ['bathtub', 'Bathtub', 'home', 'bath bathroom wash relax', '<path d="M3 12h18v3a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5zM6 12V5a2 2 0 0 1 4 0M7 20l-1 2M17 20l1 2"/>'],
  ['toolbox', 'Toolbox', 'home', 'tools kit repair maintenance', '<rect x="2" y="8" width="20" height="13" rx="2"/><path d="M8 8V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3M2 13h20M10 13v2h4v-2"/>'],
  ['plant', 'Potted plant', 'home', 'houseplant pot garden green', '<path d="M6 14h12l-1.5 7h-9z"/><path d="M12 14V7M12 10c0-3 2-5 5-5 0 3-2 5-5 5zM12 8c0-2.5-1.5-4.5-4.5-4.5 0 2.5 1.5 4.5 4.5 4.5z"/>'],
  ['broom', 'Broom', 'home', 'clean sweep housework chores', '<path d="M20.5 3.5l-7.75 7.75M10.5 9l4.5 4.5M10.5 9L5 12.5 3 21l8.5-2 3.5-5.5M8 15l-3 4.5M11 16l-4 4"/>'],
  ['watering-can', 'Watering can', 'home', 'garden plants water gardening', '<path d="M4 10h11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM6.5 10V8a3 3 0 0 1 6 0v2M15 13l5.5-5.5M19 6l3 3"/>'],
  ['washer', 'Washing machine', 'home', 'laundry appliance clothes wash', '<rect x="4" y="2" width="16" height="20" rx="2"/><circle cx="12" cy="13.5" r="5"/><path d="M7.5 5.5h.01M10.5 5.5h.01"/>'],
];

export const ICONS = RAW.map(([id, name, category, keywords, body]) => ({ id, name, category, keywords: keywords.split(' '), body }));
const byId = new Map(ICONS.map(icon => [icon.id, icon]));
const labels = new Map(ICON_CATEGORIES.map(c => [c.id, c.label]));

export const getIcon = id => byId.get(id) || null;

/** Standalone SVG with explicit colors: the image renderer and DOCX consumers may not resolve currentColor. */
export function iconSvg(id, { color = '#1F3864', strokeWidth = 2, size = 96 } = {}) {
  const icon = byId.get(id);
  if (!icon) throw new Error(`Unknown icon: ${id}`);
  const paint = /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : '#1F3864';
  const width = Number.isFinite(+strokeWidth) && +strokeWidth > 0 ? Math.min(+strokeWidth, 6) : 2;
  const px = Number.isFinite(+size) && +size > 0 ? Math.min(Math.round(+size), 2048) : 96;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="${paint}" stroke-width="${num(width)}" stroke-linecap="round" stroke-linejoin="round">${icon.body.replaceAll('currentColor', paint)}</svg>`;
}

/** Every query word must appear in the icon's name, id, keywords or category label. */
export function searchIcons(query = '', category = null) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return ICONS.filter(icon => {
    if (category && icon.category !== category) return false;
    if (!words.length) return true;
    const text = [icon.id, icon.name, labels.get(icon.category), ...icon.keywords].join(' ').toLowerCase();
    return words.every(word => text.includes(word));
  });
}
