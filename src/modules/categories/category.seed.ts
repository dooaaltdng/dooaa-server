/**
 * The twelve-category taxonomy from the Browse-by-Category frame. Slugs are
 * kept exactly as the client routes them ("automative", "gatdgets"); the
 * display names carry the corrected spelling.
 */
export const DEFAULT_CATEGORIES = [
  { slug: 'automative', name: 'Automotive', description: 'Car parts, accessories, and automotive tools & many more', image: '/images/landing/category-vehicles.jpg', home: [{ label: 'Vehicles', order: 1, image: '/images/landing/category-vehicles.jpg' }] },
  { slug: 'beauty-health', name: 'Beauty & Health', description: 'Cosmetics, skincare, and health products & many more', image: '/images/landing/category-electronics.jpg', home: [] },
  { slug: 'books', name: 'Books', description: 'Books, magazines and educational materials & many more', image: '/images/landing/category-books.jpg', home: [] },
  { slug: 'home-appliances', name: 'Home Appliances', description: 'Kitchen, laundry and home appliances & many more', image: '/images/landing/category-home-appliances.jpg', home: [{ label: 'Home Appliances', order: 6, image: '/images/landing/category-home-appliances.jpg' }] },
  {
    slug: 'gatdgets',
    name: 'Gadgets',
    description: 'Phones, laptops, audio and accessories & many more',
    image: '/images/landing/category-gadget.jpg',
    home: [
      { label: 'Electronics', order: 2, image: '/images/landing/category-electronics.jpg' },
      { label: 'Gadget', order: 5, image: '/images/landing/category-gadget.jpg' },
    ],
  },
  { slug: 'fashion', name: 'Fashion', description: 'Clothings, shoes, and fashion accessories & many more', image: '/images/landing/category-fashion.jpg', home: [{ label: 'Fashion', order: 3, image: '/images/landing/category-fashion.jpg' }] },
  { slug: 'sports', name: 'Sports', description: 'Sports equipment, fitness gear and outdoor activities & many more', image: '/images/landing/category-gadget.jpg', home: [] },
  { slug: 'toys-games', name: 'Toys & Games', description: 'Toys, board games, video games & many more', image: '/images/landing/category-property.jpg', home: [] },
  { slug: 'properties', name: 'Properties', description: 'Houses, land and rentals & many more', image: '/images/landing/category-property.jpg', home: [{ label: 'Property', order: 4, image: '/images/landing/category-property.jpg' }] },
  { slug: 'musical-instruments', name: 'Musical Instruments', description: 'Guitars, keyboards, studio gear & many more', image: '/images/landing/category-gadget.jpg', home: [] },
  { slug: 'babies-kids', name: 'Babies & Kids', description: 'Baby gear, toys and kids clothing & many more', image: '/images/landing/category-property.jpg', home: [] },
  { slug: 'gym-wears', name: 'Gym Wears', description: 'Training wear, shoes and gym accessories & many more', image: '/images/landing/category-home-appliances.jpg', home: [] },
];
