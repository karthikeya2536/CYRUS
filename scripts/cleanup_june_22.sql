UPDATE public.memory_records
SET active = FALSE
WHERE id IN (
  '4b5a9614-4d69-4bb1-9c60-55dd9b44a997',
  '04cf0262-7af2-436a-b928-d338e7e33ee5',
  '1d124bf7-517b-45c1-a70c-8c35dede36b5',
  '5cf7fbe9-79a8-489e-912e-1b2538a33adc',
  '9a21fce1-2727-4732-a59a-8fde0a8236f8'
);

UPDATE public.memory_records
SET content = 'Keerthana Rao is a collaborator on the xConnect/Innodata project.'
WHERE id = 'eee06472-662c-4f05-87ea-69dd142860e3';

UPDATE public.memory_records
SET category = 'project',
    content = 'Applied to SkillInfyTech IT Solutions Pvt Ltd.',
    expires_at = NOW() + INTERVAL '90 days'
WHERE id = 'c601cb3b-6027-4471-a041-3d11d88b38fd';

UPDATE public.memory_records
SET category = 'project',
    expires_at = NOW() + INTERVAL '90 days'
WHERE id = '0c709f3b-3fcb-48be-803a-55f9775b68dd';

UPDATE public.memory_records
SET category = 'project',
    content = 'Applied for a Graduate Apprentice Trainee position at Volvo Group (Application ID: 32792).',
    expires_at = NOW() + INTERVAL '90 days'
WHERE id = '3573d3a7-2b97-47ff-9bb3-1c41246cbc6b';
