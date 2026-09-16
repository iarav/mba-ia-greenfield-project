import { Type } from 'class-transformer';
import { IsArray, IsInt, IsString, Min, ValidateNested } from 'class-validator';

export class CompleteUploadPartDto {
  @IsInt()
  @Min(1)
  part_number: number;

  @IsString()
  etag: string;
}

export class CompleteUploadDto {
  @IsString()
  upload_id: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompleteUploadPartDto)
  parts: CompleteUploadPartDto[];
}
