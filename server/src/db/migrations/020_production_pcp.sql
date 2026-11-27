-- Standard cycles can also come from the PCP spreadsheet (PLANEJAMENTO APONTAMENTO …), with cavities.
ALTER TABLE production_standards DROP CONSTRAINT IF EXISTS production_standards_source_check;
ALTER TABLE production_standards ADD CONSTRAINT production_standards_source_check
  CHECK (source IN ('manual', 'controle_ciclo', 'planilha_pcp'));
