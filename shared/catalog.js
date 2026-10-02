export const SERVICES = [
  {id:'basic', name:'Privatrengøring', desc:'Fast og grundig rengøring af dit hjem – perfekt til en travl hverdag.', price:329, unit:'fra 329 kr.', image:'/media/service-home.webp'},
  {id:'deep', name:'Hovedrengøring', desc:'En dybdegående rengøring med ekstra fokus på detaljer, køkken og bad.', price:699, unit:'fra 699 kr.', image:'/media/service-deep.webp'},
  {id:'move', name:'Flytterengøring', desc:'Gør boligen klar til aflevering eller indflytning – uden stress.', price:1099, unit:'fra 1.099 kr.', image:'/media/cleaning-tools.webp'},
  {id:'window', name:'Vinduespudsning', desc:'Skinnende rene vinduer inde og ude, til bolig og mindre erhverv.', price:249, unit:'fra 249 kr.', image:'/media/service-windows.webp'},
  {id:'office', name:'Kontorrengøring', desc:'Fleksibel erhvervsrengøring til kontorer, klinikker og fællesarealer.', price:499, unit:'fra 499 kr.', image:'/media/office-team.webp'},
  {id:'airbnb', name:'Airbnb & feriebolig', desc:'Turnover-rengøring mellem gæster med mulighed for sengelinned og tilsyn.', price:449, unit:'fra 449 kr.', image:'/media/bedroom.jpg'}
];

export const EXTRAS = [
  {id:'oven', label:'Ovn', price:149},
  {id:'fridge', label:'Køleskab', price:129},
  {id:'windows', label:'Indvendige vinduer', price:199},
  {id:'balcony', label:'Altan', price:99},
  {id:'linen', label:'Skift af sengetøj', price:79},
  {id:'pets', label:'Ekstra pga. kæledyr', price:59}
];

export const DEFAULT_PRICING={services:Object.fromEntries(SERVICES.map(s=>[s.id,s.price])),extras:Object.fromEntries(EXTRAS.map(x=>[x.id,x.price])),sqmStepPrice:75,bathroomPrice:95,window:{included:6,perWindow:40,bothSidesPercent:50},discounts:{weekly:12,biweekly:7,monthly:3}};

export function calcPrice(b,pricing=DEFAULT_PRICING){
  const svc = SERVICES.find(s=>s.id===b.service) || SERVICES[0];
  let total = Number(pricing.services?.[svc.id]??svc.price);
  if(svc.id==='window'){const w={included:6,perWindow:40,bothSidesPercent:50,...pricing.window};total+=Math.max(0,Number(b.windowCount||6)-w.included)*w.perWindow;if(b.windowSides==='both')total*=1+w.bothSidesPercent/100;return Math.round(total);}
  const sqm = Number(b.sqm||0);
  if(sqm>60) total += Math.ceil((sqm-60)/20)*Number(pricing.sqmStepPrice??75);
  total += Math.max(0, Number(b.bathrooms||1)-1)*Number(pricing.bathroomPrice??95);
  // Recurring frequency is an agreement request. A single visit never receives an unearned discount.
  total += (b.extras||[]).reduce((sum,id)=>sum+Number(pricing.extras?.[id]??EXTRAS.find(x=>x.id===id)?.price??0),0);
  return Math.round(total);
}

