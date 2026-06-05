import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
} from "@nestjs/common";
import { MeridianError } from "meridianjs";
import { PaymentsService } from "./payments.service";

interface ChargeDto {
  amount: number;
  currency: string;
  customerId: string;
}

@Controller("payments")
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post("charge")
  @HttpCode(201)
  async charge(@Body() body: ChargeDto) {
    const { amount, currency, customerId } = body;

    if (!amount || !currency || !customerId) {
      throw new HttpException(
        "`amount`, `currency`, and `customerId` are required",
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      return await this.paymentsService.charge(amount, currency, customerId);
    } catch (err) {
      if (err instanceof MeridianError) {
        const status =
          err.category === "auth"
            ? HttpStatus.UNAUTHORIZED
            : err.category === "rate_limit"
              ? HttpStatus.TOO_MANY_REQUESTS
              : HttpStatus.BAD_GATEWAY;

        throw new HttpException(
          { message: err.message, category: err.category, provider: err.provider },
          status,
        );
      }
      throw new HttpException(
        (err as Error).message ?? "Payment failed",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post("refund/:chargeId")
  @HttpCode(200)
  async refund(@Param("chargeId") chargeId: string) {
    if (!chargeId) {
      throw new HttpException("`chargeId` param is required", HttpStatus.BAD_REQUEST);
    }

    try {
      return await this.paymentsService.refund(chargeId);
    } catch (err) {
      if (err instanceof MeridianError) {
        const status =
          err.category === "auth"
            ? HttpStatus.UNAUTHORIZED
            : err.category === "rate_limit"
              ? HttpStatus.TOO_MANY_REQUESTS
              : err.category === "validation"
                ? HttpStatus.UNPROCESSABLE_ENTITY
                : HttpStatus.BAD_GATEWAY;

        throw new HttpException(
          { message: err.message, category: err.category, provider: err.provider },
          status,
        );
      }
      throw new HttpException(
        (err as Error).message ?? "Refund failed",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
