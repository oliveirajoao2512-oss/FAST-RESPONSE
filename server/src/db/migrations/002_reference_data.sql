-- Reference data: the seven factory areas and an initial, editable catalog of problem categories.
INSERT INTO areas (slug, name, color, sort) VALUES
  ('producao', 'Produção', '#2563eb', 1),
  ('logistica', 'Logística', '#7c3aed', 2),
  ('manutencao', 'Manutenção', '#ea6a1f', 3),
  ('qualidade', 'Qualidade', '#059669', 4),
  ('processos', 'Processos', '#0891b2', 5),
  ('ferramentaria', 'Ferramentaria', '#a16207', 6),
  ('seguranca', 'Segurança', '#dc2626', 7);

INSERT INTO categories (name, area_id, is_safety, requires_evidence) VALUES
  ('Segurança do trabalho', (SELECT id FROM areas WHERE slug='seguranca'), true, true),
  ('Condição insegura', (SELECT id FROM areas WHERE slug='seguranca'), true, true),
  ('Quebra / falha de máquina', (SELECT id FROM areas WHERE slug='manutencao'), false, false),
  ('Falha de molde', (SELECT id FROM areas WHERE slug='ferramentaria'), false, false),
  ('Dispositivo / ferramental', (SELECT id FROM areas WHERE slug='ferramentaria'), false, false),
  ('Não conformidade de produto', (SELECT id FROM areas WHERE slug='qualidade'), false, true),
  ('Parâmetro de processo', (SELECT id FROM areas WHERE slug='processos'), false, false),
  ('Falta de material', (SELECT id FROM areas WHERE slug='logistica'), false, false),
  ('Movimentação / armazenagem', (SELECT id FROM areas WHERE slug='logistica'), false, false),
  ('Programação / capacidade', (SELECT id FROM areas WHERE slug='producao'), false, false),
  ('Organização / 5S', NULL, false, false),
  ('Outros', NULL, false, false);
