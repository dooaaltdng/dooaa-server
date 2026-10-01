/**
 * Demo marketplace data, mirroring the accounts and listings the apps used
 * while they ran on mocks. Only seeded when SEED_DEMO=true.
 */
export const DEMO_PASSWORD = 'Dooaa@123';

export const DEMO_BUYER = { firstName: 'Nelson', lastName: 'Okafor', email: 'nelson1234@gmail.com', phone: '09027293293', location: 'Lagos' };
export const DEMO_SELLER = { firstName: 'Amaka', lastName: 'Eze', email: 'amaka@dooaa.ng', phone: '08031234567', location: 'Lagos', storeName: 'Amaka Gadgets' };

const IMAGE = (name: string) => `/images/landing/${name}`;

export type DemoListing = {
  title: string;
  description: string;
  highlights: string[];
  categoryId: string;
  brand?: string;
  condition: 'new' | 'slightly-used' | 'used' | 'refurbished';
  price: number;
  pricing: 'fixed' | 'negotiable';
  stock: number;
  delivery: 'meetup' | 'local' | 'nationwide';
  location: string;
  image: string;
  featured?: boolean;
};

const PHONE_SPECS = [
  '6.8-inch Edge QHD+ Dynamic AMOLED 2X Display (120Hz refresh rate)',
  'Qualcomm Snapdragon 8 Gen 2 Processor',
  '12GB RAM, 512GB Internal Storage',
  '5000mAh Battery with 45W Fast Charging + Wireless Charging',
  '5G Network Support',
];

export const DEMO_LISTINGS: DemoListing[] = [
  { title: 'Samsung Galaxy S23 Ultra 5G – 12GB RAM, 512GB Storage – Phantom Black', description: 'Experience cutting-edge performance and unmatched versatility. Designed for power users, professionals and creators, it combines ultra-fast speed, incredible battery life and a display that makes everything look better.', highlights: PHONE_SPECS, categoryId: 'gatdgets', brand: 'Samsung', condition: 'new', price: 1_280_000, pricing: 'negotiable', stock: 12, delivery: 'nationwide', location: 'Ikeja, Lagos', image: IMAGE('product-iphone-12-pro.jpg'), featured: true },
  { title: 'Apple iPhone 12 Pro 512 GB Blue', description: 'Neatly used, working perfectly. Battery health 89%, no scratches, comes with the original box and charger.', highlights: ['6.1-inch Super Retina XDR display', 'A14 Bionic chip', '512GB storage, unlocked'], categoryId: 'gatdgets', brand: 'Apple', condition: 'used', price: 400_000, pricing: 'negotiable', stock: 4, delivery: 'meetup', location: 'Yaba, Lagos', image: IMAGE('product-iphone-12-pro.jpg'), featured: true },
  { title: 'Apple Watch Series 8 – 45mm Midnight Aluminium', description: 'Lightly used Apple Watch Series 8 with the original sport band and charger. Battery holds a full day.', highlights: ['45mm aluminium case', 'Blood oxygen and ECG apps', 'Always-on Retina display'], categoryId: 'gatdgets', brand: 'Apple', condition: 'slightly-used', price: 126_990, pricing: 'fixed', stock: 6, delivery: 'local', location: 'Ikoyi, Lagos', image: IMAGE('category-gadget.jpg') },
  { title: 'Sony WH-1000XM5 Wireless Noise Cancelling Headphones', description: 'Industry-leading noise cancellation with two processors and eight microphones, plus 30 hours of playback.', highlights: ['30-hour battery life', 'Multipoint connection', 'Precise voice pickup'], categoryId: 'gatdgets', brand: 'Sony', condition: 'new', price: 385_000, pricing: 'fixed', stock: 10, delivery: 'nationwide', location: 'Wuse, Abuja', image: IMAGE('category-electronics.jpg') },
  { title: 'LG 1.5HP Dual Inverter Split Air Conditioner', description: 'Energy-saving dual inverter split unit, cools fast and runs quietly. Installation kit included.', highlights: ['1.5HP cooling capacity', 'Dual inverter compressor', '10-year compressor warranty'], categoryId: 'home-appliances', brand: 'LG', condition: 'new', price: 520_000, pricing: 'fixed', stock: 5, delivery: 'local', location: 'Ikeja, Lagos', image: IMAGE('category-home-appliances.jpg') },
  { title: 'Toyota Corolla 2016 – Neat & Sound Engine', description: 'Nigerian-used Toyota Corolla with a clean interior, sound engine and complete papers. Inspection welcome before escrow release.', highlights: ['1.8L 4-cylinder, automatic', 'Odometer at 96,400 km', 'Full service history'], categoryId: 'automative', brand: 'Toyota', condition: 'used', price: 9_800_000, pricing: 'negotiable', stock: 1, delivery: 'meetup', location: 'Port Harcourt', image: IMAGE('category-vehicles.jpg'), featured: true },
  { title: 'HP EliteBook 840 G6 – Core i7, 16GB RAM, 512GB SSD', description: 'Business laptop in excellent condition, fresh Windows install, battery replaced last month.', highlights: ['Intel Core i7 8th Gen', '16GB RAM, 512GB SSD', '14-inch Full HD display'], categoryId: 'gatdgets', brand: 'HP', condition: 'refurbished', price: 610_000, pricing: 'negotiable', stock: 3, delivery: 'nationwide', location: 'Yaba, Lagos', image: IMAGE('category-electronics.jpg') },
  { title: "Nike Air Force 1 '07 – White, Size 43", description: 'Brand new in box, bought from an authorised store. Receipt available.', highlights: ['Size 43 (UK 9)', 'Leather upper', 'Original box and receipt'], categoryId: 'fashion', brand: 'Nike', condition: 'new', price: 95_000, pricing: 'fixed', stock: 8, delivery: 'nationwide', location: 'Ikoyi, Lagos', image: IMAGE('category-fashion.jpg') },
  { title: 'Nexus 5.5kg Twin Tub Washing Machine', description: 'A twin tub washer with a 5.5kg drum, spin dryer and lint filter. Lightly used and fully working.', highlights: ['5.5kg wash capacity', 'Spin dryer', 'Lint filter'], categoryId: 'home-appliances', brand: 'Nexus', condition: 'used', price: 149_000, pricing: 'negotiable', stock: 2, delivery: 'local', location: 'Ibadan', image: IMAGE('category-home-appliances.jpg') },
  { title: 'Things Fall Apart – Chinua Achebe (Hardcover)', description: 'Collector’s hardcover edition, like new.', highlights: ['Hardcover', 'Anniversary edition'], categoryId: 'books', brand: 'Penguin', condition: 'slightly-used', price: 12_500, pricing: 'fixed', stock: 15, delivery: 'nationwide', location: 'Wuse, Abuja', image: IMAGE('category-books.jpg') },
  { title: '3 Bedroom Flat – Lekki Phase 1 (Yearly Rent)', description: 'Serviced three-bedroom flat with 24-hour power, parking and security. Viewing by appointment.', highlights: ['3 bedrooms, all en suite', '24-hour power', 'Gated estate'], categoryId: 'properties', condition: 'new', price: 6_500_000, pricing: 'negotiable', stock: 1, delivery: 'meetup', location: 'Lekki, Lagos', image: IMAGE('category-property.jpg') },
  { title: 'Tecno Camon 20 Pro 5G – 256GB', description: 'Brand new, sealed in box with full warranty.', highlights: ['256GB storage', '64MP camera', '5G'], categoryId: 'gatdgets', brand: 'Tecno', condition: 'new', price: 250_000, pricing: 'fixed', stock: 20, delivery: 'nationwide', location: 'Ikeja, Lagos', image: IMAGE('product-iphone-12-pro.jpg') },
];
