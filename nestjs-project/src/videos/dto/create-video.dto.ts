import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Upper bound (bytes) enforced on `file_size`: 10 GiB. */
export const MAX_VIDEO_FILE_SIZE = 10 * 1024 * 1024 * 1024;

export class CreateVideoDto {
  @IsString()
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_FILE_SIZE)
  file_size: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  part_size?: number;
}
