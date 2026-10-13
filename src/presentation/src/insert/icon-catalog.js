// Categories for the Insert Icons dialog. The drawings are the Lucide icon
// set (ISC licence, see public/THIRD_PARTY_NOTICES.txt), loaded only when the
// dialog opens. Names not present in the installed version are skipped;
// search covers every icon, by the words in its name.

export const ICON_CATEGORIES = [
  [
    "People",
    "User Users UserRound UsersRound UserCheck UserPlus UserMinus UserX UserCog Contact Baby PersonStanding Accessibility HandHeart Handshake Hand HandHelping Smile Frown Meh Laugh Angry Annoyed SmilePlus Speech Ear Eye Brain Footprints",
  ],
  [
    "Business",
    "Briefcase BriefcaseBusiness Building Building2 Landmark Factory Store Warehouse ChartLine ChartBar ChartPie ChartColumn ChartArea ChartNoAxesCombined TrendingUp TrendingDown Target Goal Award Trophy Medal Presentation Projector Handshake BadgeDollarSign DollarSign Euro PoundSterling JapaneseYen Bitcoin Wallet CreditCard Banknote PiggyBank Receipt Calculator Coins Scale Gavel Signature FileSignature ClipboardList ClipboardCheck Kanban Network Workflow",
  ],
  [
    "Communication",
    "Mail MailOpen Send Inbox MessageCircle MessageSquare MessagesSquare Phone PhoneCall PhoneIncoming PhoneOutgoing Video Voicemail AtSign Megaphone Bell BellRing Rss Radio Podcast Mic Headphones Speaker Share Share2 Reply Forward Quote",
  ],
  [
    "Technology",
    "Laptop Monitor Smartphone Tablet Tv Keyboard Mouse Printer Server Database HardDrive Cpu MemoryStick Router Wifi Bluetooth Cloud CloudUpload CloudDownload Usb Battery BatteryCharging Plug Code Code2 Terminal Bug Bot Binary Webhook Satellite QrCode ScanLine Fingerprint Gamepad2 Headset Cable",
  ],
  [
    "Education",
    "GraduationCap School BookOpen Book Library Notebook NotebookPen PenTool Pencil Ruler Calculator Microscope FlaskConical TestTube Atom Dna Lightbulb Brain Puzzle Globe Languages Backpack Shapes Sigma Pi Infinity",
  ],
  [
    "Arrows",
    "ArrowRight ArrowLeft ArrowUp ArrowDown ArrowUpRight ArrowDownRight ArrowBigRight ArrowBigLeft ArrowBigUp ArrowBigDown ChevronRight ChevronLeft ChevronUp ChevronDown ChevronsRight ChevronsLeft MoveRight MoveLeft Repeat RefreshCw RotateCw RotateCcw Undo2 Redo2 Shuffle Merge Split CornerDownRight CornerUpLeft CircleArrowRight CircleArrowUp ArrowLeftRight ArrowUpDown Expand Shrink",
  ],
  [
    "Interface",
    "Check CheckCheck X Plus Minus Search Settings Settings2 SlidersHorizontal Menu House Star Heart Bookmark Flag Tag Pin MapPin Lock Unlock Key Shield ShieldCheck Info CircleHelp CircleAlert TriangleAlert Ban Trash2 Pencil Copy Clipboard Download Upload ExternalLink Link Filter Grid3x3 List LayoutGrid Eye EyeOff Power ToggleLeft ToggleRight",
  ],
  [
    "Nature",
    "Leaf Trees TreePine TreeDeciduous Flower Flower2 Sprout Clover Mountain MountainSnow Waves Droplet Droplets Sun Moon Cloud CloudRain CloudSnow CloudLightning Snowflake Wind Rainbow Sunrise Sunset Flame Bug Bird Fish Rabbit Squirrel Cat Dog PawPrint Turtle Shell Feather Earth",
  ],
  [
    "Travel and Places",
    "Plane PlaneTakeoff PlaneLanding Car CarFront Bus Train TrainFront Ship Sailboat Bike Truck Fuel Map MapPin Navigation Compass Globe Hotel Tent Luggage Ticket Castle Church Landmark Building TowerControl Anchor Signpost Route Milestone",
  ],
  [
    "Food and Drink",
    "Coffee CupSoda Wine Beer Martini GlassWater Milk Pizza Sandwich Salad Soup Croissant Cake CakeSlice Cookie Candy IceCreamCone Apple Banana Cherry Citrus Grape Carrot Egg Fish Beef Drumstick UtensilsCrossed Utensils ChefHat Wheat",
  ],
  [
    "Health",
    "Heart HeartPulse Activity Stethoscope Pill Syringe Thermometer Hospital Ambulance Cross Bandage Brain Bone Dna Microscope Accessibility Apple Dumbbell Bike Footprints Baby ShieldPlus",
  ],
  [
    "Media",
    "Camera Image Images Film Clapperboard Video Music Music2 Mic Headphones Play Pause CirclePlay SkipForward SkipBack Volume2 VolumeX Radio Tv Disc3 Aperture Palette Brush PaintBucket Sparkles Wand Star",
  ],
  [
    "Time and Weather",
    "Clock Clock3 AlarmClock Timer Hourglass Calendar CalendarDays CalendarCheck CalendarClock History Watch Sun Moon CloudSun CloudRain Umbrella Snowflake Thermometer Wind Sunrise",
  ],
  [
    "Security",
    "Lock LockOpen Key KeyRound Shield ShieldCheck ShieldAlert ShieldX Fingerprint ScanFace Eye EyeOff UserLock Siren BadgeCheck Vault",
  ],
  [
    "Shapes and Symbols",
    "Circle Square Triangle Diamond Hexagon Octagon Pentagon Star Heart Spade Club Shapes Infinity Hash Asterisk Percent Equal Sigma Pi Omega Ampersand AtSign CircleDot Dot Sparkle Zap",
  ],
];

/** Lucide names split into searchable words ("ArrowUpRight" → "arrow up right"). */
export const iconWords = (name) =>
  name
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
