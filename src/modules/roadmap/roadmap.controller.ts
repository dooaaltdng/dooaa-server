import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { UuidPipe } from '../../common/api/uuid.pipe';
import { StaffOnly } from '../../common/auth/decorators';
import { Trim } from '../../common/util/transforms';
import { RoadmapService } from './roadmap.service';

class GoalDto {
  @IsOptional() @IsString() @MaxLength(64) id?: string;
  @IsString() @MaxLength(120) text: string;
  @IsBoolean() done: boolean;
}

class NewPhaseDto {
  @Trim() @IsString() @MinLength(1, { message: 'Give the phase a name.' }) @MaxLength(60) label: string;
  @IsOptional() @IsString() @MaxLength(160) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => GoalDto) goals?: GoalDto[];
}

class UpdatePhaseDto {
  @IsOptional() @Trim() @IsString() @MinLength(1, { message: 'Give the phase a name.' }) @MaxLength(60) label?: string;
  @IsOptional() @IsString() @MaxLength(160) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => GoalDto) goals?: GoalDto[];
}

@ApiTags('Admin · Roadmap')
@StaffOnly()
@Controller('admin/roadmap')
export class RoadmapController {
  constructor(private readonly roadmap: RoadmapService) {}

  @Get()
  list() {
    return this.roadmap.list();
  }

  /** Adds a phase at the end of the road. */
  @Post('phases')
  add(@Body() body: NewPhaseDto) {
    return this.roadmap.add(body);
  }

  /** Removes a phase (the console confirms first). */
  @Delete('phases/:id')
  remove(@Param('id', UuidPipe) id: string) {
    return this.roadmap.remove(id);
  }

  /** Name, description and/or goals. */
  @Patch('phases/:id')
  update(@Param('id', UuidPipe) id: string, @Body() body: UpdatePhaseDto) {
    return this.roadmap.update(id, body);
  }
}
