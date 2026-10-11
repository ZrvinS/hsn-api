// [phrase, code, strength?('r' = related), note?]
const NO_RULE = "No rate rule seeded for this code (rate not established by research) - lookup returns no_rate_rule.";
const MED = "Retail dosage form assumed (3004). 33 specified life-saving drugs are Nil under 10/2025 - drug-level check needed; HSN alone is not enough.";
const MAKING = "Making charges billed within a jewellery sale are part of the 3% jewellery supply (cleartax). Job work on customer's own metal is SAC 998892 (5%).";
const SILVER_UT = "Silver utensils/articles are goldsmiths'/silversmiths' wares (7114). " + NO_RULE;

const s = [];
const add = (phrases, code, strength, note) => { for (const p of [].concat(phrases)) s.push([p, code, strength, note]); };

// ---------------- Jewellery & precious metals ----------------
add(["gold ring", "22k gold ring", "18k gold ring", "gold chain", "22k gold chain", "18k gold chain", "gold necklace", "22k gold necklace",
  "gold bangle", "gold bangles", "22k gold bangle", "gold bracelet", "gold kada", "gold earrings", "gold earring", "gold jhumka", "gold pendant", "gold mangalsutra", "mangalsutra",
  "gold nose pin", "gold nath", "gold anklet", "gold jewellery", "gold jewelry", "gold ornament", "gold ornaments", "22k gold jewellery", "18k gold jewellery", "14k gold jewellery",
  "916 gold jewellery", "hallmarked gold jewellery", "gold haram", "gold choker", "gold coin pendant",
  "kundan jewellery", "kundan necklace", "kundan set", "polki jewellery", "temple jewellery", "antique gold jewellery",
  "platinum ring", "platinum jewellery", "platinum chain", "platinum band", "jewellery", "jewelry"], "7113");
add(["diamond ring", "diamond jewellery", "diamond necklace", "diamond earrings", "diamond pendant", "diamond studded ring", "diamond bangle", "diamond nose pin", "solitaire ring"], "7113", undefined,
  "Diamond-studded gold jewellery is 7113 (3%). Loose diamonds are 7102, not 7113.");
add(["diamond studded gold jewellery"], "71131930");
add(["plain gold jewellery", "unstudded gold jewellery"], "71131910");
add(["silver jewellery", "silver ring", "silver chain", "silver anklet", "silver payal", "payal", "silver bracelet", "silver earrings", "silver toe ring", "bichiya",
  "925 silver jewellery", "sterling silver jewellery", "silver kada", "silver bangle"], "711311");
add(["jewellery making charges", "making charges", "gold making charges"], "7113", undefined, MAKING);
add(["jewellery making charges", "making charges"], "998892", "r", "Use only when invoicing job work on metal owned by the customer.");
add(["jewellery job work", "gold job work", "silver job work", "karigar charges", "jewellery repair job work"], "998892", undefined, "Job work on Chapter 71 goods other than diamonds; diamond job work is 1.5% (not seeded).");
add(["imitation jewellery job work"], "998893", undefined, NO_RULE);
add(["gold bar", "gold biscuit", "gold bullion", "24k gold bar", "24k gold", "gold bar 999", "fine gold", "gold granules", "raw gold"], "7108");
add(["gold coin", "24k gold coin", "22k gold coin"], "7108", undefined, "Non-legal-tender bullion coins are commonly billed as 7108; some classify under 7118 (Coin). Confirm with your CA.");
add(["gold coin", "silver coin"], "7118", "r", NO_RULE);
add(["silver bar", "silver bullion", "silver brick", "silver granules", "fine silver", "silver coin", "999 silver bar"], "7106");
add(["silver utensils", "silver glass", "silver plate", "silver thali", "silver bowl", "silver spoon", "silver pooja items", "silverware", "silver lamp", "silver diya"], "7114", undefined, SILVER_UT);
add(["platinum bar", "platinum bullion"], "7110", undefined, NO_RULE);
add(["pearl", "pearls", "loose pearls", "cultured pearls"], "7101");
add(["pearl necklace", "pearl mala"], "7116", undefined, "Strung pearls are 7116; pearls set in gold are 7113. " + NO_RULE);
add(["rough diamond", "uncut diamond"], "710231", undefined, "Rough industrial diamonds are 710221.");
add(["loose diamond", "cut diamond", "polished diamond", "cut and polished diamond"], "710239");
add(["lab grown diamond", "lab-grown diamond", "cvd diamond", "synthetic diamond", "american diamond", "cubic zirconia"], "7104", undefined,
  "7104 rate disputed between sources (0.25% vs 1.5%) - not seeded; verify against 9/2025 Schedules V/VI.");
add(["gemstone", "gemstones", "ruby", "emerald", "sapphire", "navratna stones", "precious stone", "semi-precious stone"], "7103", undefined, "Loose stones (not set) are 0.25% (Sch V) per research.");
add(["imitation jewellery", "artificial jewellery", "fashion jewellery", "costume jewellery", "one gram gold jewellery"], "7117", undefined,
  "7117 rate under 9/2025 not confirmed by research - not seeded. Gold-clad base-metal jewellery may be 711320 instead.");

// ---------------- Health ----------------
add(["tablet", "tablets"], "3004", "r", "Generic word: also a tablet computer (8471). " + MED);
add(["capsule", "capsules", "syrup", "cough syrup", "ointment", "medicated cream", "eye drops", "ear drops", "nasal spray", "injection",
  "insulin", "antibiotic", "medicine", "medicines", "painkiller", "paracetamol tablet", "oral suspension"], "3004", undefined, MED);
add(["paracetamol"], "3004", undefined, "Bulk paracetamol (API) is 2924; confirm retail dosage form.");
add(["paracetamol"], "2924", "r", "Only for bulk drug substance. " + NO_RULE);
add(["ayurvedic medicine", "ayurvedic tablets", "ayurvedic syrup", "churna", "chyawanprash", "homeopathic medicine", "homoeopathic medicine", "unani medicine", "pain balm"], "3004", undefined,
  "Ayurvedic/Unani/homoeopathic medicaments in retail packs fall in 3004 (5%); classification of chyawanprash and balms has been litigated - confirm.");
add(["vitamin tablets", "multivitamin", "calcium tablets"], "3004", undefined, "If sold as a food supplement/nutraceutical (FSSAI licence) it may be 2106 instead.");
add(["vitamin tablets", "multivitamin", "nutraceutical", "dietary supplement"], "2106", "r", "Food supplements are 2106; medicaments are 3004.");
add(["protein powder", "whey protein", "soy protein"], "210610", undefined, NO_RULE);
add(["glucometer", "glucose meter", "blood glucose monitor"], "9027", undefined, "Classification varies (9027 or 9018). Research lists glucometers at 5% but no HSN; no rate rule on 9027 in this seed.");
add(["glucometer", "glucose meter"], "9018", "r");
add(["test strips", "glucometer strips", "glucose test strips", "blood glucose test strips", "pregnancy test kit", "rapid test kit", "diagnostic kit", "covid test kit", "urine test strips"], "3822");
add(["bp monitor", "blood pressure monitor", "bp machine", "sphygmomanometer", "digital bp monitor", "pulse oximeter", "oximeter", "stethoscope", "surgical instruments"], "9018");
add(["syringe", "syringes", "disposable syringe", "insulin syringe"], "901831");
add(["needle", "insulin pen needle", "suture needle"], "901832");
add(["nebulizer", "nebuliser", "oxygen concentrator", "cpap machine", "massager"], "9019");
add(["hearing aid", "crutches", "knee brace", "lumbar belt", "orthopaedic belt", "cervical collar", "walking frame"], "9021");
add(["thermometer", "digital thermometer", "clinical thermometer", "infrared thermometer", "fever thermometer"], "9025", undefined, "5% rule covers medical thermometers only.");
add(["wheelchair", "wheel chair"], "8713", undefined, NO_RULE);
add(["spectacles", "eyeglasses", "reading glasses", "prescription glasses", "chashma"], "9004");
add(["sunglasses"], "9004", undefined, "Sunglasses may not be within the 5% entry for corrective spectacles - verify.");
add(["spectacle frame", "eyeglass frame", "optical frame"], "9003");
add(["spectacle lens", "spectacle lenses", "eyeglass lens"], "900150", undefined, "Glass spectacle lenses are 900140.");
add(["glass spectacle lens"], "900140");
add(["contact lens", "contact lenses", "coloured contact lenses"], "900130");
add(["face mask", "surgical mask", "n95 mask", "cloth mask"], "6307", undefined, "Chapter 63 price rule (Rs 2500 per piece) applies.");
add(["hand sanitizer", "sanitizer", "sanitiser"], "3808", undefined, "Alcohol hand sanitizer is classified by some as 3808 (disinfectant) and by others as 3004 - confirm. " + NO_RULE);
add(["baby diaper", "baby diapers", "diapers", "diaper", "adult diaper", "adult diapers", "diaper pants"], "9619", undefined, "5% rules sit at tariff items 9619 00 30/40/90 - query the 8-digit code.");
add(["sanitary pad", "sanitary pads", "sanitary napkin", "tampon", "panty liner"], "9619", undefined, "Rate for sanitary towels/tampons not in research - verify (believed exempt). Do not reuse the diaper rate.");
add(["bandage", "crepe bandage", "gauze", "adhesive bandage", "band aid", "cotton wool", "surgical dressing"], "3005", undefined, NO_RULE);
add(["first aid kit"], "3006", "r", NO_RULE);
add(["surgical gloves", "examination gloves"], "401511", undefined, NO_RULE);
add(["toothpaste", "tooth paste", "tooth powder", "dant manjan"], "330610");
add(["toothbrush"], "9603", undefined, NO_RULE);
add(["shampoo", "anti dandruff shampoo"], "330510");
add(["hair oil", "coconut hair oil", "amla hair oil"], "3305", undefined, "Edible coconut oil is 1513.");
add(["soap", "bath soap", "toilet soap", "bathing soap", "medicated soap"], "340111");
add(["handwash", "liquid soap", "body wash"], "3401", undefined, "5% seed rule covers toilet soap (340111) only. " + NO_RULE);
add(["detergent", "washing powder", "dishwash liquid"], "3402", undefined, NO_RULE);
add(["face cream", "moisturiser", "sunscreen", "talcum powder", "lipstick", "kajal"], "3304", undefined, NO_RULE);
add(["deodorant", "shaving cream"], "3307", undefined, NO_RULE);
add(["perfume", "attar"], "3303", undefined, NO_RULE);

// ---------------- Groceries & packaged food ----------------
add(["uht milk", "toned milk", "milk"], "0401", undefined, "Seed rule (Nil) covers UHT milk; fresh pouch milk is believed exempt but not seeded separately.");
add(["milk powder", "condensed milk"], "0402");
add(["curd", "dahi", "yogurt", "buttermilk", "lassi"], "0403");
add(["butter", "ghee", "desi ghee", "cow ghee"], "0405");
add(["paneer"], "040610", undefined, "Nil only when pre-packaged and labelled per research; loose paneer status not verified.");
add(["cheese", "cheese slices", "mozzarella"], "0406");
add(["eggs", "egg"], "0407");
add(["honey"], "0409");
add(["potato", "aloo"], "0701");
add(["onion", "garlic"], "0703");
add(["tomato"], "0702");
add(["dal", "toor dal", "moong dal", "chana dal", "urad dal", "masoor dal", "rajma", "kabuli chana"], "0713");
add(["cashew", "cashew nuts", "kaju"], "0801");
add(["almonds", "badam", "walnuts", "pistachio"], "0802");
add(["raisins", "kishmish"], "0806");
add(["tea", "tea leaves", "green tea", "chai patti"], "0902");
add(["coffee", "coffee beans", "filter coffee"], "0901");
add(["instant coffee"], "2101");
add(["turmeric powder", "haldi", "saffron", "ginger"], "0910");
add(["red chilli powder", "black pepper"], "0904");
add(["cumin", "jeera", "coriander seeds", "fennel seeds"], "0909");
add(["cardamom", "elaichi"], "0908");
add(["rice", "basmati rice"], "1006");
add(["wheat"], "1001");
add(["atta", "wheat flour", "maida"], "1101");
add(["besan", "gram flour"], "1106");
add(["sugar", "jaggery", "gur"], "1701");
add(["salt", "iodised salt", "rock salt"], "2501");
add(["mustard oil", "sarson oil"], "1514");
add(["sunflower oil"], "1512");
add(["soybean oil", "soyabean oil"], "1507");
add(["groundnut oil", "peanut oil"], "1508");
add(["palm oil"], "1511");
add(["coconut oil"], "1513");
add(["biscuits", "biscuit", "cookies", "cream biscuits", "rusk", "bread", "cake", "khari", "papad"], "1905");
add(["chocolate", "chocolates", "chocolate bar", "dark chocolate"], "1806");
add(["candy", "toffee", "chewing gum", "lollipop"], "1704");
add(["noodles", "instant noodles", "pasta", "macaroni", "vermicelli", "sevai"], "1902");
add(["cornflakes", "corn flakes", "muesli", "poha", "breakfast cereal"], "1904");
add(["namkeen", "bhujia", "aloo bhujia", "mixture", "farsan"], "210690");
add(["potato chips", "chips", "wafers"], "2005");
add(["pickle", "achar"], "2001");
add(["jam", "fruit jam"], "2007");
add(["ketchup", "tomato ketchup", "sauce", "soya sauce"], "2103");
add(["ice cream", "kulfi"], "2105");
add(["pan masala"], "21069020");

// ---------------- Beverages ----------------
add(["cola", "soft drink", "cold drink", "aerated drink", "soda drink", "lemon soda"], "220210");
add(["mineral water", "packaged drinking water", "bottled water", "plain soda"], "2201");
add(["fruit juice", "orange juice", "apple juice", "coconut water"], "2009");
add(["fruit drink", "mango drink", "juice drink"], "2202", undefined, "From 01-05-2026 fruit-pulp/juice-based drinks are 2202 99 21/29 (5%) - query the 8-digit code.");
add(["flavoured milk", "milkshake", "cold coffee drink"], "2202", undefined, "From 01-05-2026 milk-based beverages are 2202 99 31/39 (5%) - query the 8-digit code.");
add(["energy drink"], "22029100", undefined, "Caffeinated beverages 40% from 01-05-2026 per secondary sources.");
add(["beer"], "2203", undefined, "Alcoholic liquor for human consumption is outside GST. " + NO_RULE);

// ---------------- Electronics & appliances ----------------
add(["mobile phone", "smartphone", "mobile", "cell phone", "smart phone", "feature phone", "wifi router", "router"], "8517");
add(["smartwatch", "smart watch"], "8517", undefined, "Smartwatches are commonly classified under 8517 62; confirm.");
add(["laptop", "notebook computer"], "847130");
add(["computer", "desktop computer", "cpu"], "8471");
add(["tablet computer", "ipad", "android tablet"], "8471", "r", "Classification of tablet computers (8471 vs 8517) varies - confirm.");
add(["tv", "television", "led tv", "smart tv", "monitor", "computer monitor", "projector"], "8528");
add(["ac", "air conditioner", "split ac", "window ac"], "8415");
add(["refrigerator", "fridge"], "8418", undefined, NO_RULE);
add(["washing machine"], "8450", undefined, NO_RULE);
add(["ceiling fan", "table fan", "pedestal fan"], "8414", undefined, NO_RULE);
add(["mixer grinder", "juicer", "mixer"], "8509", undefined, NO_RULE);
add(["electric iron", "geyser", "water heater", "hair dryer", "induction cooktop"], "8516", undefined, NO_RULE);
add(["headphones", "earphones", "earbuds", "bluetooth speaker", "speaker"], "8518", undefined, NO_RULE);
add(["mobile charger", "charger", "adapter"], "8504", undefined, NO_RULE);
add(["power bank", "inverter battery"], "8507", undefined, NO_RULE);
add(["aa battery", "battery cell"], "8506", undefined, NO_RULE);
add(["led bulb", "led lamp"], "8539", undefined, NO_RULE);
add(["printer"], "8443", undefined, NO_RULE);
add(["camera", "cctv camera"], "8525", undefined, NO_RULE);
add(["wrist watch", "wristwatch"], "9102", undefined, NO_RULE);

// ---------------- Apparel & made-ups (price rule Rs 2500/piece) ----------------
add(["t-shirt", "tshirt", "t shirt", "vest", "banian"], "6109");
add(["shirt", "formal shirt", "mens shirt"], "6205");
add(["jeans", "trousers", "pant", "pants", "shorts", "blazer"], "6203", undefined, "Men's/boys' woven; women's is 6204, knitted is 61xx.");
add(["kurta", "kurti"], "6211", undefined, "Women's kurtas/suits may be 6204, knitted ones 61xx - confirm fabric and gender.");
add(["salwar suit", "dress", "skirt", "lehenga"], "6204");
add(["blouse", "ladies top"], "6206");
add(["leggings"], "6104");
add(["sweater", "sweatshirt", "hoodie", "cardigan"], "6110");
add(["socks"], "6115");
add(["baby clothes", "romper"], "6111");
add(["jacket", "windcheater"], "6201");
add(["shawl", "stole", "dupatta", "scarf"], "6214");
add(["towel", "bedsheet", "bed sheet", "pillow cover"], "6302");
add(["curtain", "curtains"], "6303");
add(["blanket"], "6301");

// ---------------- Footwear (price rule Rs 2500/pair) ----------------
add(["shoes", "footwear"], "64", undefined, "Chapter-level match; pick the 4-digit heading by upper material.");
add(["leather shoes", "formal shoes", "kolhapuri chappal"], "6403");
add(["sports shoes", "sneakers", "running shoes", "canvas shoes"], "6404");
add(["slippers", "chappal", "flip flops", "sandals", "hawai chappal"], "6402");

// ---------------- Misc ----------------
add(["cement"], "2523");
add(["notebook", "register", "diary"], "4820", undefined, NO_RULE);
add(["tissue paper", "toilet paper"], "4818", undefined, NO_RULE);
add(["steel utensils", "steel plate"], "7323", undefined, NO_RULE);
add(["bicycle", "cycle"], "8712", undefined, NO_RULE);
add(["mattress", "pillow", "quilt"], "9404", undefined, "Cotton quilts have a Rs 2500 price threshold (5%/18%) not seeded. " + NO_RULE);

// ---------------- Services ----------------
add(["hotel room", "room tariff", "hotel stay", "lodge"], "996311");
add(["restaurant", "restaurant bill", "food delivery from restaurant", "cafe"], "996331");
add(["salon", "haircut", "barber"], "999721");
add(["manicure", "pedicure"], "999722");
add(["gym", "gym membership", "yoga classes", "fitness centre", "spa"], "999723");
add(["beauty parlour", "facial"], "999729");
add(["health insurance", "mediclaim"], "997133", undefined, "Exemption is for individual policies only; group policies are taxable.");
add(["life insurance", "term insurance"], "997131", undefined, "Exemption is for individual policies only; group policies are taxable.");
add(["doctor consultation", "hospital", "clinic", "diagnostic test", "pathology lab"], "9993");


// ================= Round 3: broader everyday coverage =================
// Policy: generic single words that occur across chapters are "related" (weak hint); multi-word phrases
// and single words that point clearly to one heading are "primary". The classifier caps partial and
// single-word matches below high in any case.
const R = "r";
const PHARMA_FORM = "Dosage-form word: medicament in retail form is 3004, but the same form exists for cosmetics (3304/3305) and food supplements (2106) - confirm it is a medicament.";
// pharmacy: dosage forms (3004)
add(["gel", "cream", "lotion", "drops", "spray", "suspension", "sachet", "granules", "powder", "solution", "liquid", "rub", "balm"], "3004", R, PHARMA_FORM);
add(["inhaler", "rotacaps", "respules", "eye ointment", "skin ointment", "antiseptic cream", "antifungal cream", "antibiotic ointment", "pain relief gel", "pain relief spray", "pain relief cream",
  "oral suspension syrup", "dry syrup", "nasal drops", "eye gel", "vaginal gel", "oral gel", "mouth ulcer gel", "injection vial", "insulin injection", "ors sachet",
  "oral rehydration salts", "antacid", "antacid syrup", "antacid gel", "digestive tablets", "iron tablets", "calcium supplement tablets", "vitamin d3 sachet", "cough rub", "vapour rub", "vapor rub",
  "chest rub", "cold rub", "cough lozenges", "throat lozenges", "laxative", "antiallergic tablets", "medicated lotion", "medicated powder", "medicated shampoo", "ayurvedic oil", "ayurvedic churna",
  "homeopathic drops", "homoeopathic dilution", "mother tincture", "effervescent tablets", "chewable tablets", "suppository", "transdermal patch"], "3004", undefined,
  "Retail medicament assumed (3004). Medicated shampoo/powder and some rubs/balms have been classified elsewhere (3305/3304) - confirm. 33 nil-rated drugs need a name-level check.");
add(["antiseptic liquid"], "3808", R, "Antiseptic liquids are classified by some as 3808 94 (disinfectant) and by others as 3004 - confirm.");
add(["antiseptic liquid"], "3004", R, "Medicated antiseptic in retail form may be 3004 - confirm.");
add(["glucose powder", "glucose-d", "dextrose powder"], "1702", undefined, NO_RULE);
add(["condom", "condoms", "hot water bag", "feeding bottle nipple", "teat"], "4014", undefined, "Research lists nipples at 5% but no rule is seeded for 4014. " + NO_RULE);
add(["petroleum jelly", "vaseline"], "2712", undefined, NO_RULE);
add(["mouthwash", "dental floss"], "3306", undefined, "5% seed rule covers dentifrices (330610) only. " + NO_RULE);
add(["baby powder", "lip balm", "body lotion", "nail polish", "face powder", "foundation", "compact powder", "cold cream", "fairness cream", "night cream", "face serum", "makeup remover"], "3304", undefined, NO_RULE);
add(["face wash"], "3401", R, "Surfactant-based facial cleansers are 3401; cream cleansers may be 3304.");
add(["face wash"], "3304", R, "Cream cleansers may be 3304; surfactant-based ones are 3401.");
add(["hair dye", "hair colour", "hair color", "henna hair colour", "hair gel", "hair serum", "conditioner", "hair conditioner"], "3305", undefined, "5% seed rule on 3305 is scoped to hair oil and shampoo; other hair preparations not verified.");
add(["baby wipes", "wet wipes"], "3401", R, "Wipes impregnated with soap/detergent are 3401; with cosmetics 3307 - confirm.");
add(["shaving foam", "aftershave", "room freshener", "air freshener", "agarbatti", "incense sticks", "dhoop"], "3307", undefined, NO_RULE);
add(["razor", "razor blade", "shaving blade", "disposable razor"], "8212", undefined, NO_RULE);
add(["mosquito repellent", "mosquito coil", "mosquito liquid vaporizer refill", "cockroach spray", "insect killer spray", "rat poison"], "3808", undefined, NO_RULE);
add(["floor cleaner", "toilet cleaner", "glass cleaner", "dishwash bar", "dishwash gel", "liquid detergent", "laundry detergent", "fabric conditioner"], "3402", undefined, "Dishwash bars are sometimes classified as 3401 - confirm. " + NO_RULE);
add(["candle", "candles"], "3406", undefined, NO_RULE);
add(["matchbox", "match box", "matches"], "3605", undefined, NO_RULE);
add(["adult diaper pants", "baby wipes pack"], "9619", R);
add(["digital thermometer for fever", "ear thermometer", "forehead thermometer"], "9025", undefined, "5% rule covers medical thermometers only.");
add(["weighing scale", "body weight scale"], "84", R, "Personal weighing scales are 8423 (not in this seed master). " + NO_RULE);

// supermarket
add(["oats", "rolled oats"], "1104", undefined, "Instant/flavoured prepared oats may be 1904.");
add(["instant oats", "masala oats"], "1904");
add(["suji", "sooji", "rava", "semolina", "dalia", "daliya"], "1103");
add(["corn flour", "cornflour", "corn starch", "arrowroot powder"], "1108");
add(["peanuts", "groundnuts", "moongphali"], "1202", undefined, "Roasted or salted peanuts are 2008.");
add(["roasted peanuts", "salted peanuts", "peanut butter", "roasted chana", "masala peanuts"], "2008", undefined, "Roasted gram may be 2008 or 1904 - confirm.");
add(["mustard seeds", "rai", "sesame seeds", "til"], "1207");
add(["hing", "asafoetida"], "1301", undefined, "Compounded hing (with flour) may be 2106 or 0910 - confirm.");
add(["cinnamon", "dalchini"], "0906");
add(["cloves", "laung"], "0907");
add(["garam masala", "chaat masala", "sambar masala", "chole masala", "pav bhaji masala", "kitchen king masala", "biryani masala", "meat masala", "mixed spices"], "0910", undefined,
  "Mixtures of spices are 0910 91; mixed condiments/seasonings with other ingredients are 2103 90 - confirm.");
add(["coriander powder", "dhania powder", "jeera powder", "cumin powder"], "0909");
add(["chilli powder", "mirchi powder", "kashmiri chilli", "dry red chilli"], "0904");
add(["olive oil"], "1509");
add(["rice bran oil", "sesame oil", "gingelly oil", "til oil"], "1515");
add(["vanaspati", "dalda", "hydrogenated vegetable oil"], "1516");
add(["refined oil", "cooking oil", "edible oil"], "15", R, "Chapter-level: the heading depends on the oil (1507-1515).");
add(["malt drink", "malted milk drink", "health drink powder", "baby food", "infant cereal", "infant formula", "cerelac"], "1901", undefined,
  "Malt drinks with 40% or more cocoa, and cocoa-based health drinks, are 1806 - confirm composition.");
add(["chocolate health drink", "cocoa powder drink mix", "drinking chocolate"], "1806");
add(["cocoa powder"], "18", R, "Unsweetened cocoa powder is 1805 (not in this seed master).");
add(["frozen peas", "frozen vegetables", "frozen sweet corn"], "0710");
add(["frozen french fries", "frozen fries", "frozen potato wedges"], "2004");
add(["chicken", "chicken breast", "frozen chicken", "fresh chicken"], "0207");
add(["mutton", "goat meat"], "0204");
add(["yeast", "baking powder", "dry yeast"], "2102");
add(["soup", "instant soup", "soup powder"], "2104");
add(["vinegar", "apple cider vinegar"], "2209");
add(["mayonnaise", "chutney", "schezwan sauce", "pizza sauce", "pasta sauce", "chilli sauce"], "2103");
add(["custard powder", "jelly crystals", "sugar free sweetener", "sweetener", "sharbat", "squash", "rooh afza", "drink concentrate", "rasna"], "2106", undefined,
  "Food preparations n.e.c. (2106). The 5% seed rule on 210690 is scoped to namkeen-type items only.");
add(["popcorn", "ready to eat popcorn"], "1904", undefined, "Popcorn may be 1904 or 2008 - confirm.");
add(["frozen dessert"], "2105");
add(["cheese spread", "cheese cubes", "processed cheese"], "0406");
add(["fresh cream", "dairy cream", "toned milk pouch", "full cream milk"], "0401", undefined, "The Nil seed rule on 0401 is scoped to UHT milk only.");
add(["khoa", "mawa"], "04", R, "Khoa classification (0402/0406) not established - confirm.");
add(["tea bags", "masala tea", "assam tea", "darjeeling tea", "leaf tea", "dust tea"], "0902");
add(["coffee powder", "filter coffee powder", "ground coffee"], "0901", undefined, "Instant coffee is 2101.");
add(["dates", "khajur", "mango", "mangoes", "guava"], "0804");
add(["banana", "bananas"], "0803");
add(["apple", "apples"], "0808");
add(["dry fruits", "mixed dry fruits"], "08", R, "Chapter-level: pick the heading by fruit/nut.");
add(["pav", "bun", "burger bun", "pizza base", "wafer biscuits", "digestive biscuits", "marie biscuits", "khakhra", "toast", "bread toast", "muffin", "cupcake", "brownie", "puff pastry"], "1905");
add(["chocolate cookies", "chocolate chip cookies"], "1905", undefined, "Biscuits/cookies with chocolate stay in 1905.");
add(["energy bar", "protein bar", "granola bar", "muesli bar"], "1904", R, "Cereal bars are usually 1904; chocolate-coated bars may be 1806 - confirm.");
add(["noodles cup", "cup noodles", "hakka noodles", "rice noodles"], "1902");
add(["pani puri", "golgappa puri", "fryums"], "1905", R, "Unfried snack pellets may be 1903/1905 - confirm.");
add(["sugar cubes", "brown sugar", "mishri", "khandsari"], "1701");
add(["toffees", "mints", "mouth freshener mints", "lollipops", "jelly candy", "gummies"], "1704");
add(["mukhwas", "mouth freshener"], "2106", R, "Mouth fresheners (supari-free) are generally 2106 - confirm.");

// beverages
add(["soft drink bottle", "carbonated soft drink", "cola drink", "lemonade", "lime soda", "orange soda", "tonic water", "ginger ale", "club soda flavoured", "fizzy drink", "aerated water", "flavoured soda", "masala soda", "jeera soda"], "220210");
add(["soda", "cold drink bottle"], "220210", R, "Unflavoured, unsweetened soda water is 2201.");
add(["soda water", "club soda"], "2201");
add(["sports drink", "electrolyte drink", "iced tea", "ice tea", "glucose drink", "nimbu pani bottle"], "2202", undefined, "Since 01-05-2026 2202 is split into 8-digit lines with different rates - query the 8-digit code.");
add(["mango juice", "litchi juice", "mixed fruit juice", "guava juice", "pineapple juice", "tomato juice", "aloe vera juice", "amla juice"], "2009", undefined, "100% juice is 2009; fruit drinks/nectars with added water and sugar are 2202 99 21/29.");
add(["mango drink bottle", "fruit nectar", "fruit beverage"], "2202", undefined, "Fruit-pulp/juice based drinks: 2202 99 21/29 (5% from 01-05-2026).");
add(["lassi bottle", "chaas bottle", "flavoured buttermilk", "masala chaas"], "0403");
add(["cold coffee", "coffee milkshake", "badam milk", "rose milk", "chocolate milk"], "2202", undefined, "Milk-based beverages: 2202 99 31/39 (5% from 01-05-2026).");
add(["red bull", "monster energy"], "22029100", R, "Brand names: caffeinated energy drinks per secondary sources.");

// electronics & appliances
add(["mouse", "keyboard"], "847160", R, "Generic words: computer input units are 8471 60 (a 'mouse' could also be a toy).");
add(["computer mouse", "wireless mouse", "optical mouse", "gaming mouse", "computer keyboard", "wireless keyboard", "keyboard and mouse combo", "scanner", "barcode scanner", "webcam"], "847160", undefined,
  "Webcams are often classified as 8525 (cameras) - confirm.");
add(["webcam"], "8525", R);
add(["hard disk", "hard drive", "external hard disk", "external hard drive", "hdd", "ssd", "solid state drive", "internal ssd", "portable ssd", "nas storage"], "847170", undefined,
  "Storage units of 8471 70. Some portable SSDs are classified as 8523 51 - confirm.");
add(["pen drive", "pendrive", "usb flash drive", "usb pen drive", "flash drive", "memory card", "sd card", "micro sd card", "microsd card"], "852351", undefined, "Solid-state non-volatile storage (8523 51). " + NO_RULE);
add(["ram", "computer ram", "laptop ram", "motherboard", "graphics card", "processor", "cpu cabinet", "smps", "laptop battery", "laptop keyboard replacement", "cooling pad"], "847330", undefined,
  "Parts of 8471 machines (8473 30). Processors (ICs) are 8542 and laptop batteries 8507 - confirm. " + NO_RULE);
add(["laptop bag", "backpack", "school bag", "handbag", "wallet", "purse", "suitcase", "trolley bag", "jewellery box"], "4202", undefined, NO_RULE);
add(["mobile cover", "phone case", "mobile back cover"], "3926", R, "Plastic phone cases are often 3926; leather/textile cases 4202 - confirm. " + NO_RULE);
add(["calculator", "scientific calculator"], "8470", undefined, NO_RULE);
add(["usb cable", "data cable", "charging cable", "hdmi cable", "type c cable", "lan cable", "ethernet cable", "electric wire", "copper wire", "extension cord"], "8544", undefined, NO_RULE);
add(["switch", "socket"], "8536", R, "Generic words: electrical switches/sockets are 8536.");
add(["extension board", "power strip", "spike guard", "electrical switch", "modular switch", "plug socket", "mcb", "fuse"], "8536", undefined, NO_RULE);
add(["inverter", "ups", "voltage stabilizer", "stabilizer", "mobile adapter", "laptop charger", "fast charger"], "8504", undefined, "Inverter batteries are 8507. " + NO_RULE);
add(["tube light", "led tube light", "led batten", "ceiling light", "table lamp", "decorative lights", "led strip light", "emergency light"], "9405", undefined, "LED lamps (bulbs) are 8539; luminaires/fittings are 9405. " + NO_RULE);
add(["torch", "flashlight", "rechargeable torch"], "8513", undefined, NO_RULE);
add(["trimmer", "beard trimmer", "hair clipper", "electric shaver", "epilator"], "8510", undefined, NO_RULE);
add(["electric kettle", "microwave oven", "microwave", "otg oven", "toaster", "sandwich maker", "room heater", "hair straightener", "induction stove", "rice cooker", "air fryer", "coffee maker"], "8516", undefined, NO_RULE);
add(["vacuum cleaner", "robot vacuum"], "8508", undefined, NO_RULE);
add(["water purifier", "ro water purifier", "ro purifier"], "8421", undefined, NO_RULE);
add(["air cooler", "desert cooler", "room cooler"], "8479", undefined, "Evaporative air coolers are commonly classified 8479 60 - confirm. " + NO_RULE);
add(["exhaust fan", "wall fan", "bldc fan"], "8414", undefined, NO_RULE);
add(["hand blender", "food processor", "wet grinder", "chopper electric"], "8509", undefined, NO_RULE);
add(["double door refrigerator", "single door refrigerator", "deep freezer", "mini fridge"], "8418", undefined, NO_RULE);
add(["front load washing machine", "top load washing machine"], "8450", undefined, NO_RULE);
add(["bluetooth earphones", "wireless earbuds", "tws earbuds", "neckband", "bluetooth neckband", "soundbar", "home theatre speaker", "wired earphones", "gaming headset", "microphone"], "8518", undefined, NO_RULE);
add(["android phone", "iphone", "keypad phone", "basic phone", "smart band", "fitness band", "wifi dongle", "modem"], "8517");
add(["set top box", "led monitor", "gaming monitor", "android tv", "4k tv", "oled tv", "qled tv"], "8528");
add(["laptop computer", "gaming laptop", "chromebook", "macbook", "ultrabook"], "847130");
add(["all in one pc", "desktop pc", "mini pc", "personal computer"], "8471");
add(["inkjet printer", "laser printer", "printer cartridge", "toner cartridge", "ink cartridge"], "8443", undefined, "Cartridges are parts/accessories of 8443 - confirm. " + NO_RULE);
add(["cctv", "security camera", "action camera", "dslr camera", "digital camera", "dashcam"], "8525", undefined, NO_RULE);
add(["aaa battery", "alkaline battery", "button cell", "cell battery"], "8506", undefined, NO_RULE);
add(["led bulbs", "led light bulb", "smart bulb", "cfl bulb"], "8539", undefined, NO_RULE);
add(["split air conditioner", "inverter ac", "window air conditioner"], "8415");

// jewellery shop
add(["ring", "chain", "bangle", "bangles", "necklace", "earrings", "pendant", "anklet", "bracelet", "nath"], "7113", R,
  "Generic jewellery word: precious-metal jewellery is 7113 (3%); imitation jewellery is 7117 and glass bangles 7018 - confirm the metal.");
add(["gold nose ring", "nose ring", "nose stud", "maang tikka", "gold maang tikka", "kamarbandh", "waist chain", "gold waist chain", "bajuband", "armlet", "gold kada for men", "gents gold ring",
  "ladies gold ring", "gold finger ring", "gold engagement ring", "gold wedding ring", "couple rings gold", "gold rope chain", "gold box chain", "gold bracelet for men", "gold jhumki", "gold studs",
  "gold tops earrings", "gold hoops", "gold locket", "gold mangalsutra chain", "gold kundan set", "bridal jewellery set", "gold bridal set", "rani haar", "gold coin pendant chain", "22k gold bangles",
  "18k diamond ring", "diamond stud earrings", "diamond tennis bracelet", "diamond mangalsutra", "rose gold ring", "white gold ring", "platinum couple bands", "navratna ring",
  "gemstone ring", "ruby ring", "emerald ring", "pearl earrings gold", "temple jewellery set"], "7113", undefined,
  "Precious-metal jewellery (7113, 3%). Check the metal: base-metal or gold-plated pieces are 7117.");
add(["silver payal pair", "silver chain for men", "silver bracelet for men", "silver nose pin", "silver ring for men", "silver bichiya pair", "oxidised silver jewellery", "silver kamarbandh"], "711311", undefined,
  "Silver jewellery (7113 11). 'Oxidised' pieces are sometimes base metal (7117) - confirm.");
add(["silver kalash", "silver puja thali", "silver idol", "silver gift items", "silver photo frame", "silver tumbler", "silver katori"], "7114", undefined, "Silver articles (7114); idols may be 7114 or 9703 - confirm. Silver coins: see 7106/7118. " + NO_RULE);
add(["gold plated jewellery", "gold plated necklace", "gold plated bangles", "oxidised jewellery", "kundan imitation set", "american diamond jewellery", "ad jewellery", "artificial bangles", "fashion earrings"], "7117", undefined,
  "Imitation jewellery (7117); rate not seeded - research could not confirm the 9/2025 rate.");
add(["glass bangles", "kanch ki chudiyan", "glass chudi"], "7018", undefined, NO_RULE);
add(["24k gold biscuit", "999 gold bar", "995 gold bar", "fine gold bar"], "7108");
add(["24k gold coin", "gold guinea"], "7118", R, "Coins may be 7118 or billed as bullion 7108 - confirm. " + NO_RULE);
add(["999 silver", "silver bullion bar"], "7106");
add(["old gold exchange", "old gold"], "7108", R, "Old gold bought back from customers: classification and reverse-charge treatment need CA review.");
add(["hallmarking charges", "huid charges", "polishing charges", "gold polishing"], "998892", R, "Service on customer's goods; SAC for hallmarking is not established here - confirm.");
add(["watch", "watches", "analog watch", "digital watch", "ladies watch", "gents watch"], "9102", undefined, "Smartwatches are 8517. " + NO_RULE);

// apparel & footwear extras (price rules apply at chapter level)
add(["men t-shirt", "polo t-shirt", "round neck t-shirt", "kids t-shirt", "innerwear vest", "sando vest"], "6109");
add(["cotton shirt", "linen shirt", "check shirt", "denim shirt", "office shirt"], "6205");
add(["track pants", "joggers", "sweat pants", "night suit knitted", "pyjama knitted"], "61", R, "Knitted garments are chapter 61; heading depends on type.");
add(["kurta pyjama", "sherwani", "nehru jacket", "dhoti", "lungi"], "62", R, "Woven traditional garments: chapter 62; heading depends on type and gender.");
add(["saree", "sari", "silk saree", "cotton saree"], "50", R, "Sarees are usually classified as woven fabric of the relevant fibre (chapters 50-55), not as apparel - confirm.");
add(["handkerchief", "hanky"], "62", R, "Handkerchiefs are 6213 (woven) or 6117 (knitted) - not in this seed master.");
add(["school shoes", "loafers", "formal leather shoes", "mojari", "juttis"], "6403");
add(["running shoes for men", "training shoes", "walking shoes", "canvas sneakers", "slip on shoes"], "6404", undefined, "Sports shoes with rubber/plastic uppers are 6402 - confirm upper material.");
add(["crocs", "rubber slippers", "bathroom slippers", "eva slippers", "floaters", "plastic sandals"], "6402");

export const synonyms = s.map(([phrase, hsn_code, strength, note]) => {
  const o = { phrase, hsn_code };
  if (strength === "r") o.strength = "related";
  if (note) o.note = note;
  return o;
});

export const categoryMap = [
  ...[
    ["en:biscuits", "1905"], ["en:cookies", "1905"], ["en:breads", "1905"], ["en:cakes", "1905"], ["en:rusks", "1905"],
    ["en:chocolates", "1806"], ["en:dark-chocolates", "1806"], ["en:milk-chocolates", "1806"], ["en:cocoa-and-its-products", "18"],
    ["en:candies", "1704"], ["en:chewing-gum", "1704"], ["en:confectioneries", "17"],
    ["en:breakfast-cereals", "1904"], ["en:pastas", "1902"], ["en:noodles", "1902"], ["en:instant-noodles", "1902"],
    ["en:jams", "2007"], ["en:sauces", "2103"], ["en:ketchup", "2103"], ["en:pickles", "2001"], ["en:crisps", "2005"], ["en:potato-crisps", "2005"],
    ["en:ice-creams", "2105"], ["en:dietary-supplements", "2106"], ["en:protein-powders", "210610"],
    ["en:sodas", "220210"], ["en:carbonated-drinks", "220210"], ["en:colas", "220210"], ["en:energy-drinks", "2202"], ["en:waters", "2201"], ["en:mineral-waters", "2201"],
    ["en:fruit-juices", "2009"], ["en:juices-and-nectars", "20"], ["en:beers", "2203"],
    ["en:teas", "0902"], ["en:coffees", "0901"], ["en:instant-coffees", "2101"],
    ["en:milks", "0401"], ["en:uht-milks", "0401"], ["en:yogurts", "0403"], ["en:butters", "0405"], ["en:ghee", "0405"], ["en:cheeses", "0406"], ["en:paneer", "040610"],
    ["en:eggs", "0407"], ["en:honeys", "0409"],
    ["en:rices", "1006"], ["en:wheat-flours", "1101"], ["en:flours", "11"], ["en:sugars", "1701"], ["en:salts", "2501"], ["en:spices", "09"],
    ["en:legumes", "07"], ["en:fresh-vegetables", "07"], ["en:fresh-fruits", "08"], ["en:nuts", "08"], ["en:dried-fruits", "08"],
    ["en:vegetable-oils", "15"], ["en:sunflower-oils", "1512"], ["en:mustard-oils", "1514"], ["en:soybean-oils", "1507"], ["en:palm-oils", "1511"], ["en:coconut-oils", "1513"], ["en:peanut-oils", "1508"],
  ].map(([category, hsn_prefix]) => ({ source: "open_food_facts", category, hsn_prefix })),
  ...[
    ["en:shampoos", "330510"], ["en:toothpastes", "330610"], ["en:soaps", "3401"], ["en:bar-soaps", "340111"], ["en:hair-oils", "3305"], ["en:hair-care", "3305"],
    ["en:deodorants", "3307"], ["en:perfumes", "3303"], ["en:face-creams", "3304"], ["en:sunscreens", "3304"], ["en:make-up", "3304"], ["en:body-lotions", "3304"],
    ["en:shower-gels", "3401"], ["en:diapers", "9619"], ["en:sanitary-pads", "9619"],
  ].map(([category, hsn_prefix]) => ({ source: "open_beauty_facts", category, hsn_prefix })),
];

const ck = {
  "71": "sona chandi kada jhumka jhumki tikka nath bichiya 916 gold silver platinum diamond diamonds jewellery jewelry 22k 18k 24k 14k kundan polki pearl pearls bangle bangles necklace mangalsutra earrings earring pendant hallmark hallmarked bullion carat solitaire gemstone payal anklet",
  "30": "gel spray drops inhaler sachet granules rub balm antacid antiseptic lozenges syrups tablet tablets capsule capsules syrup mg mcg ointment injection ayurvedic homeopathic homoeopathic unani suspension medicine medicines antibiotic insulin",
  "90": "glucometer thermometer oximeter spectacles eyeglasses lens lenses stethoscope sphygmomanometer bp nebulizer nebuliser syringe hearing",
  "38": "sanitizer sanitiser strips diagnostic",
  "19": "biscuits biscuit cookies bread cake noodles pasta cornflakes rusk muesli",
  "18": "chocolate chocolates cocoa",
  "09": "masala cinnamon cloves dalchini tea coffee turmeric haldi jeera cumin cardamom elaichi pepper spices",
  "21": "coffee namkeen bhujia sauce ketchup protein masala",
  "10": "rice wheat basmati",
  "11": "atta flour maida besan suji sooji rava oats",
  "17": "sugar jaggery gur candy toffee",
  "25": "salt cement",
  "15": "oil",
  "33": "conditioner serum facewash agarbatti oil shampoo toothpaste cream perfume deodorant lotion sunscreen",
  "34": "soap detergent handwash cleaner",
  "04": "milk ghee butter paneer cheese curd dahi honey egg eggs",
  "07": "dal potato onion tomato",
  "08": "cashew almonds raisins kaju badam",
  "20": "juice pickle jam chips",
  "22": "lemonade juice soda water drink cola beer",
  "61": "t-shirt tshirt leggings sweater socks hoodie",
  "62": "shirt jeans trousers kurta kurti dress blouse",
  "63": "towel bedsheet curtain blanket mask",
  "64": "loafers crocs floaters shoes shoe sandals slippers chappal footwear sneakers",
  "85": "pendrive usb cable earbuds neckband trimmer kettle microwave heater bulb switch soundbar mobile smartphone phone tv television led charger earphones headphones speaker battery mixer grinder",
  "84": "laptop computer printer ac refrigerator fridge fan mouse keyboard ssd hdd harddisk purifier cooler calculator",
  "87": "wheelchair bicycle",
  "96": "diaper diapers sanitary toothbrush tampon",
  "24": "tobacco cigarette",
  "99": "service services hotel restaurant salon insurance consultation",
};
export const chapterKeywords = Object.entries(ck).flatMap(([chapter, words]) => words.split(" ").map((keyword) => ({ keyword, chapter })));
