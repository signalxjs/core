/**
 * The server-side catalog. Static data with simulated fetch latency so the
 * category sections STREAM: the shell (header, hero, cart badge) flushes
 * immediately, each section replaces its placeholder as its "query" lands —
 * and every card in the replacement is interactive on arrival, because
 * delegation reads attributes at dispatch time.
 */

export interface Product {
    id: string;
    name: string;
    emoji: string;
    price: number;
}

export interface Category {
    slug: string;
    title: string;
    blurb: string;
    products: Product[];
}

const CATALOG: Category[] = [
    {
        slug: 'plants',
        title: 'Plants',
        blurb: 'Photosynthesis included.',
        products: [
            ['monstera', 'Monstera', '🪴', 34], ['cactus', 'Cactus', '🌵', 12],
            ['bonsai', 'Bonsai', '🌳', 89], ['fern', 'Fern', '🌿', 18],
            ['sunflower', 'Sunflower', '🌻', 9], ['tulip', 'Tulip', '🌷', 7],
            ['palm', 'Palm', '🌴', 45], ['sprout', 'Sprout', '🌱', 4],
            ['rose', 'Rose', '🌹', 11], ['lotus', 'Lotus', '🪷', 22],
            ['hibiscus', 'Hibiscus', '🌺', 14], ['bouquet', 'Bouquet', '💐', 29]
        ].map(([id, name, emoji, price]) => ({ id, name, emoji, price }) as Product)
    },
    {
        slug: 'gear',
        title: 'Gear',
        blurb: 'Tools that outlive trends.',
        products: [
            ['camera', 'Camera', '📷', 249], ['headphones', 'Headphones', '🎧', 129],
            ['keyboard', 'Keyboard', '⌨️', 95], ['watch', 'Watch', '⌚', 199],
            ['flashlight', 'Flashlight', '🔦', 24], ['compass', 'Compass', '🧭', 31],
            ['binoculars', 'Binoculars', '🔭', 88], ['radio', 'Radio', '📻', 42],
            ['battery', 'Battery', '🔋', 15], ['microscope', 'Microscope', '🔬', 155],
            ['telescope', 'Telescope', '🛰️', 320], ['joystick', 'Joystick', '🕹️', 39]
        ].map(([id, name, emoji, price]) => ({ id, name, emoji, price }) as Product)
    },
    {
        slug: 'pantry',
        title: 'Pantry',
        blurb: 'Provisions for long sessions.',
        products: [
            ['coffee', 'Coffee', '☕', 16], ['croissant', 'Croissant', '🥐', 4],
            ['ramen', 'Ramen', '🍜', 8], ['sushi', 'Sushi', '🍣', 19],
            ['taco', 'Taco', '🌮', 6], ['pretzel', 'Pretzel', '🥨', 3],
            ['honey', 'Honey', '🍯', 12], ['avocado', 'Avocado', '🥑', 2],
            ['cheese', 'Cheese', '🧀', 14], ['olives', 'Olives', '🫒', 7],
            ['dumpling', 'Dumpling', '🥟', 9], ['matcha', 'Matcha', '🍵', 13]
        ].map(([id, name, emoji, price]) => ({ id, name, emoji, price }) as Product)
    },
    {
        slug: 'workshop',
        title: 'Workshop',
        blurb: 'Make something today.',
        products: [
            ['hammer', 'Hammer', '🔨', 21], ['wrench', 'Wrench', '🔧', 17],
            ['saw', 'Saw', '🪚', 33], ['screwdriver', 'Screwdriver', '🪛', 9],
            ['ruler', 'Ruler', '📏', 5], ['scissors', 'Scissors', '✂️', 8],
            ['paint', 'Paint', '🎨', 26], ['thread', 'Thread', '🧵', 4],
            ['magnet', 'Magnet', '🧲', 11], ['gears', 'Gears', '⚙️', 47],
            ['toolbox', 'Toolbox', '🧰', 74], ['ladder', 'Ladder', '🪜', 59]
        ].map(([id, name, emoji, price]) => ({ id, name, emoji, price }) as Product)
    }
];

/** Category slugs in display order (sync — drives the section skeletons). */
export function categorySlugs(): string[] {
    return CATALOG.map((category) => category.slug);
}

/** "Fetch" one category — staggered latency makes the streaming visible. */
export async function loadCategory(slug: string): Promise<Category> {
    const index = CATALOG.findIndex((category) => category.slug === slug);
    await new Promise((resolve) => setTimeout(resolve, 150 + index * 200));
    return CATALOG[index];
}
