CREATE TABLE IF NOT EXISTS pricing_settings (
  id integer PRIMARY KEY CHECK(id=1),
  config jsonb NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO pricing_settings(id,config) VALUES(1,'{"services":{"basic":329,"deep":699,"move":1099,"window":249,"office":499,"airbnb":449},"extras":{"oven":149,"fridge":129,"windows":199,"balcony":99,"linen":79,"pets":59},"sqmStepPrice":75,"bathroomPrice":95,"discounts":{"weekly":12,"biweekly":7,"monthly":3}}') ON CONFLICT(id) DO NOTHING;
