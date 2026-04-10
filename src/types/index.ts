export interface Hospital {
  id: string;
  name: string;
  ae_title: string;
  is_active: boolean;
  r2_bucket: string;
}

export interface HospitalAccess {
  id: string;
  hospital_id: string;
  name: string;
  ae_title: string;
  allowed_ip: string | null;
  is_active: boolean;
  hospital: Hospital;
}

export interface DicomStudyInsert {
  study_instance_uid: string;
  hospital_id: string;
  ae_title_source: string;
  ae_title_destination: string;
  patient_name?: string;
  patient_id?: string;
  patient_age?: string;
  patient_sex?: string;
  study_description?: string;
  study_date?: string;
  modality?: string;
  total_instances: number;
  received_instances: number;
  receive_status: "receiving" | "complete" | "failed";
}

export interface DicomInstanceInsert {
  sop_instance_uid: string;
  series_instance_uid: string;
  instance_number: number;
  storage_url: string;
  sop_class_uid: string;
  series_number: number;
  series_description: string;
  rows: number;
  columns: number;
  bits_allocated: number;
  bits_stored: number;
  high_bit: number;
  pixel_representation: number;
  slice_thickness?: number;
  pixel_spacing?: [number, number];
  image_orientation?: [number, number, number, number, number, number];
  image_position?: [number, number, number];
  window_center?: number;
  window_width?: number;
  rescale_intercept?: number;
  rescale_slope?: number;
  rescale_type?: string;
  samples_per_pixel?: number;
  photometric_interpretation?: string;
  number_of_frames?: number;
}
